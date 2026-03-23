const { Tag, EthernetIP } = require('st-ethernet-ip');

module.exports = function(RED) {
    function EIPPulseNode(config) {
        RED.nodes.createNode(this, config);
        
        this.connection = RED.nodes.getNode(config.connection);
        this.name = config.name;
        this.pulseTime = parseInt(config.pulseTime) || 1000; // Default 1 second
        
        const node = this;
        
        if (!this.connection) {
            this.error('No connection configured');
            return;
        }
        
        // Register with the connection
        this.connection.addUser(this);
        
        // Set initial status
        this.status({fill: 'yellow', shape: 'ring', text: 'connecting'});
        
        // Track active pulses to prevent overlapping
        this.activePulses = new Set();
        
        // Monitor connection status
        const updateStatus = () => {
            if (node.connection.connected) {
                if (node.activePulses.size > 0) {
                    node.status({fill: 'blue', shape: 'dot', text: `pulsing (${node.activePulses.size})`});
                } else {
                    node.status({fill: 'green', shape: 'dot', text: 'connected'});
                }
            } else if (node.connection.connecting) {
                node.status({fill: 'yellow', shape: 'ring', text: 'connecting'});
            } else {
                node.status({fill: 'red', shape: 'ring', text: 'disconnected'});
            }
        };
        
        // Update status periodically
        const statusInterval = setInterval(updateStatus, 1000);
        
        this.on('input', async function(msg, send, done) {
            // Node-RED 1.0 compatibility
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };
            
            try {
                // Validate connection
                if (!node.connection) {
                    const errorMsg = 'No connection configured';
                    node.error(errorMsg, msg);
                    done();
                    return;
                }
                
                if (!node.connection.connected || !node.connection.controller) {
                    const errorMsg = 'PLC not connected';
                    node.error(errorMsg, msg);
                    done();
                    return;
                }

                // Validate input message
                if (!msg || !msg.payload) {
                    const errorMsg = 'Invalid message: payload is required';
                    node.error(errorMsg, msg);
                    done();
                    return;
                }
                
                let pulseTime = node.pulseTime; // Default from config
                
                // Parse input message for tag object
                const tagObj = msg.payload.tag;
                
                if (!tagObj || typeof tagObj !== 'object') {
                    const errorMsg = 'Invalid tag object. Use msg.payload.tag = {name: "TagName"}';
                    node.error(errorMsg, msg);
                    done();
                    return;
                }
                
                const tagName = tagObj.name;
                
                // Check for optional pulseTime override
                if (msg.payload.pulseTime && typeof msg.payload.pulseTime === 'number') {
                    pulseTime = msg.payload.pulseTime;
                }
                
                // Validation
                if (!tagName || typeof tagName !== 'string' || tagName.trim().length === 0) {
                    const errorMsg = 'tagName must be specified as a non-empty string in msg.payload.tag.name';
                    node.error(errorMsg, msg);
                    done();
                    return;
                }
                
                if (pulseTime <= 0) {
                    const errorMsg = 'pulseTime must be a positive number (milliseconds)';
                    node.error(errorMsg, msg);
                    done();
                    return;
                }
                
                // Check if this tag is already being pulsed
                if (node.activePulses.has(tagName)) {
                    const errorMsg = `Tag "${tagName}" is already being pulsed. Please wait for current pulse to complete.`;
                    node.error(errorMsg, msg);
                    done();
                    return;
                }
                
                // Main pulse operation
                try {
                    // Create tag instance and read current value
                    const tag = new Tag(tagName.trim());
                    await node.connection.controller.readTag(tag);
                    
                    // Check if tag is boolean type
                    if (tag.type !== 'BOOL') {
                        throw new Error(`Tag ${tagName} is not a BOOL type (datatype: ${tag.type}). Pulse operation only works with BOOL tags.`);
                    }
                    
                    // Store original value
                    const originalValue = tag.value;
                    
                    // Add to active pulses
                    node.activePulses.add(tagName);
                    updateStatus();
                    
                    // Set tag to true (pulse start)
                    tag.value = true;
                    await node.connection.controller.writeTag(tag);
                    
                    node.debug(`Pulse started for tag ${tagName}, original value: ${originalValue}`);
                    
                    // Send pulse start message
                    const startMsg = {
                        payload: {
                            success: true,
                            ok: true,
                            tag: {
                                name: tagName
                            },
                            originalValue: originalValue,
                            currentValue: true, // Always pulse to true
                            operation: 'pulse_start',
                            pulseTime: pulseTime,
                            timestamp: new Date().toISOString()
                        },
                        topic: msg.topic || tagName
                    };
                    
                    // Preserve original message properties
                    Object.keys(msg).forEach(key => {
                        if (!startMsg.hasOwnProperty(key) && key !== 'payload' && key !== 'topic') {
                            startMsg[key] = msg[key];
                        }
                    });
                    
                    // send(startMsg);
                    
                    // Set timeout to reset tag after pulse time
                    setTimeout(async () => {
                        try {
                            // Reset tag to original value (pulse end)
                            tag.value = originalValue;
                            await node.connection.controller.writeTag(tag);
                            
                            // Remove from active pulses
                            node.activePulses.delete(tagName);
                            updateStatus();
                            
                            node.debug(`Pulse completed for tag ${tagName}, reset to original value: ${originalValue}`);
                            
                            // Send pulse end message
                            const endMsg = {
                                payload: {
                                    success: true,
                                    ok: true,
                                    tag: {
                                        name: tagName
                                    },
                                    originalValue: originalValue,
                                    currentValue: originalValue,
                                    operation: 'pulse_end',
                                    pulseTime: pulseTime,
                                    timestamp: new Date().toISOString()
                                },
                                topic: msg.topic || tagName
                            };
                            
                            // Preserve original message properties
                            Object.keys(msg).forEach(key => {
                                if (!endMsg.hasOwnProperty(key) && key !== 'payload' && key !== 'topic') {
                                    endMsg[key] = msg[key];
                                }
                            });
                            
                            send(endMsg);
                            
                        } catch (err) {
                            // Remove from active pulses even if reset failed
                            node.activePulses.delete(tagName);
                            updateStatus();
                            
                            const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
                            node.error(`Failed to reset tag ${tagName} after pulse: ${errorMessage}`);
                            
                            // Send error message for pulse end failure
                            const errorMsg = {
                                payload: {
                                    success: false,
                                    tag: {
                                        name: tagName
                                    },
                                    operation: 'pulse_end',
                                    error: err.message,
                                    timestamp: new Date().toISOString()
                                },
                                topic: msg.topic || tagName
                            };
                            
                            send(errorMsg);
                        }
                    }, pulseTime);
                    
                    done();
                    
                } catch (err) {
                    // Remove from active pulses on error
                    if (node.activePulses && tagName) {
                        node.activePulses.delete(tagName);
                    }
                    node.status({fill: 'red', shape: 'dot', text: 'error'});
                    
                    // Create error output message with safe error handling
                    const errorOutput = {
                        payload: {
                            success: false,
                            tag: {
                                name: tagName || 'unknown'
                            },
                            operation: 'pulse_start',
                            error: err && err.message ? err.message : 'Unknown error occurred',
                            timestamp: new Date().toISOString()
                        },
                        topic: msg.topic || (tagName || 'unknown')
                    };
                    
                    // Safely preserve original message properties
                    if (msg && typeof msg === 'object') {
                        Object.keys(msg).forEach(key => {
                            try {
                                if (!errorOutput.hasOwnProperty(key) && key !== 'payload' && key !== 'topic') {
                                    errorOutput[key] = msg[key];
                                }
                            } catch (preserveErr) {
                                // Ignore property copy errors
                            }
                        });
                    }
                    
                    const errorMsg = `Failed to pulse tag "${tagName || 'unknown'}": ${err && err.message ? err.message : 'Unknown error'}`;
                    node.warn(errorMsg);
                    
                    if (send) {
                        send(errorOutput);
                    }
                    
                    // Restore status after error
                    setTimeout(() => {
                        try {
                            updateStatus();
                        } catch (statusErr) {
                            // Ignore status update errors
                        }
                    }, 2000);
                    
                    done(); // Always call done() to prevent crashes
                }
            } catch (outerErr) {
                // Outer catch for validation errors
                node.error('Pulse node validation error: ' + (outerErr && outerErr.message ? outerErr.message : 'Unknown error'), msg);
                done();
            }
        });
        
        this.on('close', function() {
            try {
                if (statusInterval) {
                    clearInterval(statusInterval);
                }
                
                // Clear any active pulses
                if (node.activePulses) {
                    node.activePulses.clear();
                }
                
                if (node.connection && typeof node.connection.removeUser === 'function') {
                    node.connection.removeUser(node);
                }
            } catch (err) {
                // Ignore cleanup errors
                node.debug('Error during pulse node cleanup: ' + (err && err.message ? err.message : 'Unknown error'));
            }
        });
    }
    
    RED.nodes.registerType('eip-pulse', EIPPulseNode);
};