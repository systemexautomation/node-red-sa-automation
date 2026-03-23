const { Tag, EthernetIP } = require('st-ethernet-ip');

module.exports = function(RED) {

    function EIPWriteNode(config) {
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
        
        // Set initial status
        this.status({fill: 'yellow', shape: 'ring', text: 'connecting'});
        
        // Monitor connection status
        const updateStatus = () => {
            if (node.connection.connected) {
                node.status({fill: 'green', shape: 'dot', text: 'connected'});
            } else if (node.connection.connecting) {
                node.status({fill: 'yellow', shape: 'ring', text: 'connecting'});
            } else {
                node.status({fill: 'red', shape: 'ring', text: 'disconnected'});
            }
        };
        
        // Update status periodically
        const statusInterval = setInterval(updateStatus, 1000);
        
        // Method to write a single tag with timeout
        const writeSingleTag = async (tagName, tagValue, tagType) => {
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Write operation timed out after 3 seconds')), 3000)
            );
            
            const writeOperation = async () => {
                if (tagType === 'STRING' || tagType === 'string') {
                    // For STRING tags, use connection controller's newTag method
                    const tag = node.connection.controller.newTag(tagName);
                    await node.connection.controller.readTag(tag);
                    tag.value = tagValue;
                    await node.connection.controller.writeTag(tag);
                } else {
                    // For other types, use regular Tag with connection controller
                    const tag = new Tag(tagName);
                    await node.connection.controller.readTag(tag);
                    tag.value = tagValue;
                    await node.connection.controller.writeTag(tag);
                }
            };
            
            return Promise.race([writeOperation(), timeout]);
        };
        
        this.on('input', async function(msg) {
            try {
                if (!node.connection?.connected) {
                    node.error('PLC not connected');
                    return;
                }
                
                // Check if we have multiple tags to write
                if (msg.payload?.tags && Array.isArray(msg.payload.tags) && msg.payload.tags.length > 0) {
                    // Write multiple tags
                    const results = [];
                    let hasErrors = false;
                    
                    for (const tagInfo of msg.payload.tags) {
                        try {
                            if (!tagInfo?.name) {
                                node.error(`Tag missing name: ${JSON.stringify(tagInfo)}`);
                                hasErrors = true;
                                results.push({ name: tagInfo?.name, ok: false, error: 'Missing tag name' });
                                continue;
                            }
                            
                            if (tagInfo.value === undefined) {
                                node.error(`Tag "${tagInfo.name}" missing value`);
                                hasErrors = true;
                                results.push({ name: tagInfo.name, ok: false, error: 'Missing tag value' });
                                continue;
                            }
                            
                            // Use the same single tag write method
                            await writeSingleTag(tagInfo.name, tagInfo.value, tagInfo.type);
                            results.push({ name: tagInfo.name, ok: true });
                            
                        } catch (err) {
                            const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
                            node.error(`Write failed for tag "${tagInfo.name}": ${errorMessage}`);
                            hasErrors = true;
                            results.push({ name: tagInfo.name, ok: false, error: errorMessage });
                        }
                    }
                    
                    // Send results
                    msg.payload.ok = !hasErrors;
                    msg.payload.results = results;
                    node.send(msg);
                    
                } else {
                    // Single tag write
                    if (!msg.payload?.tag?.name) {
                        node.error('payload.tag.name is required');
                        return;
                    }
                    
                    if (msg.payload.tag.value === undefined) {
                        node.error('payload.tag.value is required');
                        return;
                    }
                    
                    // Use the same single tag write method
                    await writeSingleTag(msg.payload.tag.name, msg.payload.tag.value, msg.payload.tag.type);
                    
                    // Add success indicator and send same payload
                    msg.payload.ok = true;
                    node.send(msg);
                }
                
            } catch (err) {
                const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
                node.error(`Write failed: ${errorMessage}`);
                msg.payload.ok = false;
                node.send(msg);
            }
        });
        
        this.on('close', function() {
            try {
                if (statusInterval) {
                    clearInterval(statusInterval);
                }
                if (node.connection && typeof node.connection.removeUser === 'function') {
                    node.connection.removeUser(node);
                }
            } catch (err) {
                // Ignore cleanup errors
                node.debug('Error during node cleanup: ' + (err && err.message ? err.message : 'Unknown error'));
            }
        });
    }
    
    RED.nodes.registerType('eip-write', EIPWriteNode);
};