const { Tag, TagGroup } = require('st-ethernet-ip');

module.exports = function (RED) {
    
    // Helper function to parse PLC STRING data from buffer
    function parseStringFromBuffer(buffer) {
        if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
            return buffer; // Not a string buffer, return as-is
        }
        
        try {
            // PLC STRING structure: first 4 bytes = length (DINT), then string data
            const length = buffer.readUInt32LE(0);
            
            // Validate length is reasonable
            if (length < 0 || length > buffer.length - 4) {
                return buffer; // Invalid length, return buffer as-is
            }
            
            // Extract string data (skip first 4 length bytes)
            const stringData = buffer.slice(4, 4 + length);
            return stringData.toString('utf8');
        } catch (err) {
            // If parsing fails, return the buffer as-is
            return buffer;
        }
    }
    
    // Helper function to process tag value (parse strings if needed)
    function processTagValue(tag) {
        let value = tag.value;
        
        // If value is a buffer, try to parse it as a string
        if (Buffer.isBuffer(value)) {
            value = parseStringFromBuffer(value);
        }
        
        return value;
    }

    function EIPSubscriptionNode(config) {
        RED.nodes.createNode(this, config);

        this.connection = RED.nodes.getNode(config.connection);
        this.name = config.name;

        const node = this;

        if (!this.connection) {
            this.error('No connection configured');
            return;
        }

        // Register with the connection
        this.connection.addUser(this);

        // Tag management
        let tagGroup = new TagGroup();
        const tagValues = new Map(); // Store previous values for change detection
        const subscribedTags = new Set(); // Track subscribed tag names
        const missingTags = new Set(); // Track failed/missing tag names
        let additionalPayloadData = {}; // Store additional data from input payload
        let readTimer = null;
        let isReading = false;
        let readInterval = config.updateRate || 400;
        let errorCount = 0;
        const MAX_ERRORS = 3;
        const MAX_INTERVAL = 2000; 

        // Update status
        const updateStatus = () => {
            const isConnected = node.connection && node.connection.connected;
            const isConnecting = node.connection && node.connection.connecting;
            
            node.debug(`Status update - Connected: ${isConnected}, Connecting: ${isConnecting}, Tags: ${subscribedTags.size}`);
            
            if (isConnected) {
                if (subscribedTags.size > 0) {
                    node.status({ fill: 'green', shape: 'dot', text: `subscribed (${subscribedTags.size})` });
                } else {
                    node.status({ fill: 'green', shape: 'dot', text: 'connected' });
                }
            } else if (isConnecting) {
                node.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });
            } else {
                node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
            }
        };



        // Periodic reading cycle
        const startReadingCycle = () => {
            if (readTimer || subscribedTags.size === 0) return;

            // Reset error tracking when starting new cycle
            errorCount = 0;
            readInterval = config.updateRate || 400;

            const doRead = async () => {
                if (isReading || !node.connection.connected || !node.connection.controller) {
                    return;
                }

                try {
                    isReading = true;

                    // Read all tags at once
                    await node.connection.controller.readTagGroup(tagGroup);

                    // Check for changes
                    let hasChanges = false;
                    const allValues = {};

                    // Collect tags to remove if they become unavailable
                    const tagsToRemove = [];

                    tagGroup.forEach(tag => {
                        const tagName = tag.name;
                        const rawValue = tag.value;
                        const currentValue = processTagValue(tag); // Parse strings if needed
                        const previousValue = tagValues.get(tagName);

                        // Only treat undefined as invalid, null is a valid tag value
                        if (currentValue === undefined) {
                            node.warn(`Tag "${tagName}" unexpectedly returned undefined - may have become unavailable`);
                            // Mark for removal from tagGroup and tracking sets
                            tagsToRemove.push(tagName);
                            missingTags.add(tagName);
                            tagValues.delete(tagName);
                        } else {
                            // Store current value for next comparison (including null)
                            tagValues.set(tagName, currentValue);

                            // Add to all values object (including null)
                            allValues[tagName] = currentValue;

                            // Remove from missing tags if it was there
                            missingTags.delete(tagName);

                            // Check if this tag changed
                            if (previousValue !== currentValue) {
                                hasChanges = true;
                            }
                        }
                    });

                    // Remove unavailable tags from TagGroup and subscribedTags
                    if (tagsToRemove.length > 0) {
                        for (const tagName of tagsToRemove) {
                            // Find and remove the tag from TagGroup
                            for (let i = tagGroup.length - 1; i >= 0; i--) {
                                if (tagGroup[i] && tagGroup[i].name === tagName) {
                                    tagGroup.splice(i, 1);
                                    break;
                                }
                            }
                            subscribedTags.delete(tagName);
                        }
                        node.debug(`Removed ${tagsToRemove.length} unavailable tags from subscription: ${tagsToRemove.join(', ')}`);
                    }

                    // If any tag changed, send ALL current values in one message
                    if (hasChanges) {
                        const missing = Array.from(missingTags);
                        const found = allValues;

                        const outputMsg = {
                            payload: {
                                status: found && Object.keys(found).length === 0 ? "error" : missing.length > 0 ? "warning" : "success",
                                message: missing.length === 0
                                    ? "All requested tags found."
                                    : found && Object.keys(found).length === 0
                                        ? "No requested tags were found."
                                        : `Some tags were not found: ${missing.join(", ")}`,
                                missingTags: missing.length ? missing : undefined,
                                tags: found,
                                ok: Object.keys(found).length > 0,
                                ...additionalPayloadData // Include additional data from input
                            },
                            topic: 'all_values'
                        };

                        node.send(outputMsg);
                        node.debug(`Sent all tag values due to changes: ${Object.keys(allValues).length} successful, ${missingTags.size} missing`);
                        node.debug(`Additional data included: ${JSON.stringify(additionalPayloadData)}`);
                    }

                    // Reset error count and interval on success
                    errorCount = 0;
                    readInterval = config.updateRate || 400;

                } catch (err) {
                    // Increment error count and implement exponential backoff
                    errorCount++;
                    if (errorCount <= MAX_ERRORS) {
                        readInterval = Math.min(readInterval * 2, MAX_INTERVAL);

                        // Stop reading cycle if too many errors
                        if (errorCount >= MAX_ERRORS) {
                            stopReadingCycle();
                            node.status({ fill: 'red', shape: 'ring', text: 'read errors' });
                            const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
                            node.warn(`Too many read errors (${errorCount}), stopping cycle: ${errorMessage}`);
                            return;
                        }
                    }

                    const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
                    node.warn(`Read cycle error: ${errorMessage}`);
                } finally {
                    isReading = false;
                }
            };

            readTimer = setInterval(doRead, readInterval); // Use dynamic interval
            node.debug('Started reading cycle');
        };

        const stopReadingCycle = () => {
            if (readTimer) {
                clearInterval(readTimer);
                readTimer = null;
                node.debug('Stopped reading cycle');
            }
        };

        // Subscribe to tags (clear existing and start fresh)
        const subscribeToTags = async (tagNames, skipValidation = false) => {
            if (!Array.isArray(tagNames)) {
                node.error('Expected array of tag names');
                return;
            }

            if (!node.connection.connected || !node.connection.controller) {
                node.error('PLC not connected');
                return;
            }

            // Clear existing subscriptions first
            clearAllSubscriptions();

            const newTags = [];

            if (skipValidation) {
                node.debug('Skipping tag value validation, adding all tags directly (will still validate tag creation)');
                
                // Add all tags directly without testing their values
                for (const tagName of tagNames) {
                    if (typeof tagName !== 'string' || tagName.trim().length === 0) {
                        node.warn(`Invalid tag name: ${tagName}`);
                        missingTags.add(tagName);
                        continue;
                    }

                    const cleanTagName = tagName.trim();
                    
                    try {
                        const tag = new Tag(cleanTagName);
                        tagGroup.add(tag);
                        subscribedTags.add(cleanTagName);
                        newTags.push(cleanTagName);
                        node.debug(`Added tag (no value validation): ${cleanTagName}`);
                    } catch (err) {
                        // Tag creation failed - invalid tag name format
                        missingTags.add(cleanTagName);
                        node.warn(`Failed to create tag "${cleanTagName}": ${err.message || err}`);
                    }
                }
            } else {
                // Original validation logic - test each individually first
                for (const tagName of tagNames) {
                    if (typeof tagName !== 'string' || tagName.trim().length === 0) {
                        node.warn(`Invalid tag name: ${tagName}`);
                        continue;
                    }

                    const cleanTagName = tagName.trim();

                    try {
                        // Test the tag individually before adding to TagGroup
                        const testTag = new Tag(cleanTagName);
                        await node.connection.controller.readTag(testTag);

                        // If read was successful (undefined is invalid, but null is valid)
                        if (testTag.value !== undefined) {
                            const tag = new Tag(cleanTagName);
                            tagGroup.add(tag);
                            subscribedTags.add(cleanTagName);
                            newTags.push(cleanTagName);

                            // Store initial value for change detection (including null)
                            tagValues.set(cleanTagName, testTag.value);

                            node.debug(`Added tag: ${cleanTagName}`);
                        } else {
                            // Tag returns undefined - mark as missing
                            missingTags.add(cleanTagName);
                            node.warn(`Tag "${cleanTagName}" returned undefined - marked as missing`);
                        }

                    } catch (err) {
                        // Tag failed to read - mark as missing and don't add to TagGroup
                        missingTags.add(cleanTagName);

                        // node.warn(`Failed to add tag "${cleanTagName}": ${err && err.message ? err.message : (err ? String(err) : 'Unknown error')}`);
                        const errorMessage = err
                            ? (err.message || JSON.stringify(err, Object.getOwnPropertyNames(err)) || String(err))
                            : 'Unknown error';

                        // Only warn for non-common errors to reduce spam
                        if (errorMessage && !errorMessage.includes('undefined') && !errorMessage.includes('Unrecognized Type')) {
                            // node.warn(`Failed to test tag "${cleanTagName}": ${errorMessage}`);
                        } else {
                            node.debug(`Tag "${cleanTagName}" failed validation (${errorMessage}) - marked as missing`);
                        }
                    }
                }
            }

            // Start reading cycle if we have tags
            if (subscribedTags.size > 0) {
                startReadingCycle();
            }

            updateStatus();

            // Send notification if no valid tags were found
            if (subscribedTags.size === 0 && missingTags.size > 0) {
                const outputMsg = {
                    payload: {
                        status: "error",
                        message: "No valid tags found - no subscriptions active.",
                        missingTags: Array.from(missingTags),
                        tags: {},
                        ok: false,
                        ...additionalPayloadData
                    },
                    topic: 'all_values'
                };
                node.send(outputMsg);
                node.debug('Sent notification for no valid tags found');
            }
            // Send initial values for successfully added tags
            else if (newTags.length > 0 || missingTags.size > 0) {
                setTimeout(() => sendAllCurrentValues(), 200);
            }
        };

        // Send all current tag values at once (like st-ethernet-ip getAllTagValues)
        const sendAllCurrentValues = async () => {
            if (!node.connection.connected || !node.connection.controller || subscribedTags.size === 0) {
                return;
            }

            try {
                // Read current TagGroup to get all values
                await node.connection.controller.readTagGroup(tagGroup);

                // Create object with all current values
                const allValues = {};
                tagGroup.forEach(tag => {
                    // Check if tag value is valid
                    if (tag.value !== undefined && tag.value !== null) {
                        const processedValue = processTagValue(tag); // Parse strings if needed
                        allValues[tag.name] = processedValue;
                        // Store for change detection
                        tagValues.set(tag.name, processedValue);
                        // Remove from missing if it was there
                        missingTags.delete(tag.name);
                    } else {
                        // Add to missing tags
                        missingTags.add(tag.name);
                        node.warn(`Tag "${tag.name}" returned undefined/null value during getAllTagValues`);
                    }
                });

                // Send all values in one message (similar to st-ethernet-ip format)
                const missing = Array.from(missingTags);
                const found = allValues;

                const allValuesMsg = {
                    payload: {
                        status: found && Object.keys(found).length === 0 ? "error" : missing.length > 0 ? "warning" : "success",
                        message: missing.length === 0
                            ? "All requested tags found."
                            : found && Object.keys(found).length === 0
                                ? "No requested tags were found."
                                : `Some tags were not found: ${missing.join(", ")}`,
                        missingTags: missing.length ? missing : undefined,
                        tags: found,
                        ok: Object.keys(found).length > 0,
                        ...additionalPayloadData // Include additional data from input
                    },
                    topic: 'all_values'
                };

                node.send(allValuesMsg);
                node.debug(`Sent all current values: ${Object.keys(allValues).length} successful, ${missingTags.size} missing`);
                node.debug(`Additional data included: ${JSON.stringify(additionalPayloadData)}`);

            } catch (err) {
                const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
                node.error(`Failed to send all current values: ${errorMessage}`);
            }
        };

        // Send initial values for new tags only
        const sendInitialValues = async (tagNames) => {
            if (!node.connection.connected || !node.connection.controller) {
                return;
            }

            try {
                const initialTags = [];

                for (const tagName of tagNames) {
                    try {
                        const tag = new Tag(tagName);
                        await node.connection.controller.readTag(tag);

                        // Check if tag value is valid
                        if (tag.value !== undefined && tag.value !== null) {
                            const processedValue = processTagValue(tag); // Parse strings if needed
                            // Store initial value for change detection
                            tagValues.set(tagName, processedValue);

                            initialTags.push({
                                name: tagName,
                                value: processedValue
                            });

                            // Remove from missing if it was there
                            missingTags.delete(tagName);
                        } else {
                            // Add to missing tags
                            missingTags.add(tagName);
                            node.warn(`Tag "${tagName}" returned undefined/null value`);
                        }

                    } catch (readErr) {
                        // Add to missing tags on any error
                        missingTags.add(tagName);
                        node.warn(`Failed to read initial value for "${tagName}": ${readErr && readErr.message ? readErr.message : (readErr ? String(readErr) : 'Unknown error')}`);
                        const errorMessage = readErr && readErr.message ? readErr.message : (readErr ? String(readErr) : 'Unknown error');

                        // Only warn for non-undefined errors to reduce spam
                        if (errorMessage && errorMessage !== 'undefined') {
                            node.warn(`Failed to read initial value for "${tagName}": ${errorMessage}`);
                        } else {
                            node.debug(`Tag "${tagName}" failed to read (likely missing or incorrect path)`);
                        }
                    }
                }

                // Always send ALL current values after processing new tags
                setTimeout(() => sendAllCurrentValues(), 100);

            } catch (err) {
                const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
                node.error(`Failed to send initial values: ${errorMessage}`);
            }
        };

        // Clear all subscriptions
        const clearAllSubscriptions = () => {
            try {
                stopReadingCycle();

                // Reset error tracking
                errorCount = 0;
                readInterval = config.updateRate || 400;

                // Recreate TagGroup (simpler than removing individual tags)
                tagGroup = new TagGroup();
                subscribedTags.clear();
                tagValues.clear();
                missingTags.clear();

                updateStatus();
                node.debug('Cleared all subscriptions');

            } catch (err) {
                const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
                node.error(`Failed to clear subscriptions: ${errorMessage}`);
            }
        };

        // Handle incoming messages
        this.on('input', async function (msg) {
            try {
                if (!msg || !msg.payload) {
                    node.error('Invalid message: payload is required');
                    return;
                }

                const payload = msg.payload;

                // Debug: log the incoming payload
                node.debug(`Received payload: ${JSON.stringify(payload)}`);

                // Extract and store additional payload data (excluding known command fields)
                const { tags, action, args, ...additional } = payload;
                if (Object.keys(additional).length > 0) {
                    additionalPayloadData = additional;
                }

                // Check for skip validation argument
                const skipValidation = args && Array.isArray(args) && args.includes('skip_validation');
                if (skipValidation) {
                    node.debug('Skip validation requested');
                }

                // Normalize action (trim whitespace and convert to lowercase for comparison)
                const normalizedAction = action ? action.toString().trim().toLowerCase() : null;
                node.debug(`Normalized action: "${normalizedAction}"`);

                if (payload.tags && Array.isArray(payload.tags)) {
                    // Check if empty array - treat as clear action
                    if (payload.tags.length === 0) {
                        node.debug('Empty tags array received - clearing all subscriptions');
                        clearAllSubscriptions();
                        
                        // Send notification that no tags are being monitored
                        const outputMsg = {
                            payload: {
                                status: "info",
                                message: "No tags provided - subscription cleared.",
                                missingTags: [],
                                tags: {},
                                ok: false,
                                ...additionalPayloadData
                            },
                            topic: 'all_values'
                        };
                        node.send(outputMsg);
                        node.debug('Sent notification for empty tags array');
                        return;
                    }
                    
                    // If we have tags but not connected, try to reconnect
                    if (!node.connection.connected) {
                        node.debug('Not connected, attempting to reconnect for tag subscription');
                        try {
                            await node.connection.connect();
                            // Give a moment for connection to establish
                            await new Promise(resolve => setTimeout(resolve, 500));
                        } catch (connErr) {
                            node.error(`Failed to reconnect for tag subscription: ${connErr && connErr.message ? connErr.message : 'Unknown error'}`);
                            return;
                        }
                    }
                    
                    // Subscribe to tags
                    subscribeToTags(payload.tags, skipValidation);
                } else if (normalizedAction === 'clear') {
                    // Clear all subscriptions
                    clearAllSubscriptions();
                } 
                // else if (normalizedAction === 'disconnect') {
                //     // Clear subscriptions and disconnect
                //     clearAllSubscriptions();
                //     if (node.connection.connected) {
                //         node.debug('Disconnecting from PLC');
                //         try {
                //             await node.connection.disconnect();
                //             // Update status immediately after disconnect
                //             updateStatus();
                //         } catch (disconnectErr) {
                //             node.warn(`Error during disconnect: ${disconnectErr && disconnectErr.message ? disconnectErr.message : 'Unknown error'}`);
                //         }
                //     } else {
                //         // Already disconnected, just update status
                //         updateStatus();
                //     }
                // } 
                else if (normalizedAction === 'read_all') {
                    // Force send all current values (like st-ethernet-ip getAllTagValues)
                    sendAllCurrentValues();
                } else {
                    node.error('Invalid payload format. Expected {tags: [\"tag1\", \"tag2\"]} or {tags: []} to clear, {action: \"clear\"}, {action: \"disconnect\"}, or {action: \"read_all\"}');
                }

            } catch (err) {
                const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
                node.error('Input processing error: ' + errorMessage);
            }
        });

        // Listen for connection state changes
        this.connection.on('connected', () => {
            node.debug('Connection event: connected');
            updateStatus();
        });

        this.connection.on('disconnected', () => {
            node.debug('Connection event: disconnected');
            updateStatus();
        });

        this.connection.on('error', (err) => {
            node.debug('Connection event: error');
            node.status({ fill: 'red', shape: 'ring', text: 'connection error' });
            const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
            node.error('Connection error: ' + errorMessage);
        });

        // Periodic status update to catch missed events
        const statusCheckInterval = setInterval(() => {
            updateStatus();
        }, 2000); // Check every 2 seconds

        // Cleanup on node close
        this.on('close', function () {
            clearAllSubscriptions();

            // Clear status check interval
            if (statusCheckInterval) {
                clearInterval(statusCheckInterval);
            }

            if (node.connection) {
                node.connection.removeUser(node);
            }
        });

        // Initial status update - check current connection state
        setTimeout(() => {
            updateStatus();
        }, 100); // Small delay to ensure connection state is properly initialized
    }

    RED.nodes.registerType('eip-subscription', EIPSubscriptionNode);
};
