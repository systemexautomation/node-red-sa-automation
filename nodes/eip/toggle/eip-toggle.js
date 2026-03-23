const { Tag, EthernetIP } = require('st-ethernet-ip');

module.exports = function(RED) {
    function EIPToggleNode(config) {
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
        
        // Listen for connection state changes
        this.connection.on('connecting', () => {
            node.status({fill: 'yellow', shape: 'ring', text: 'connecting'});
        });
        
        this.connection.on('connected', () => {
            updateStatus();
        });
        
        this.connection.on('disconnected', () => {
            updateStatus();
        });
        
        this.connection.on('error', (err) => {
            node.status({fill: 'red', shape: 'ring', text: 'error'});
            const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
            node.error('Connection error: ' + errorMessage);
        });
        
        // Handle incoming messages
        this.on('input', async function(msg) {
            try {
                // Validate connection
                if (!node.connection) {
                    node.error('No connection configured', msg);
                    return;
                }
                
                if (!node.connection.connected) {
                    node.error('Not connected to PLC', msg);
                    return;
                }
                
                // Validate input message
                if (!msg || !msg.payload) {
                    node.error('Invalid message: payload is required', msg);
                    return;
                }
                
                const tagObj = msg.payload.tag;
                
                if (!tagObj || typeof tagObj !== 'object') {
                    node.error('Invalid tag object. Use msg.payload.tag = {name: "TagName"}', msg);
                    return;
                }
                
                const tagName = tagObj.name;
                
                if (!tagName || typeof tagName !== 'string' || tagName.trim().length === 0) {
                    node.error('Tag name must be specified as a non-empty string in msg.payload.tag.name', msg);
                    return;
                }
                
                node.status({fill: 'blue', shape: 'dot', text: 'toggling...'});
                
                try {
                    // Read current tag value first
                    const tag = new Tag(tagName.trim());
                    await node.connection.controller.readTag(tag);
                    
                    // Get current value and toggle it
                    const currentValue = tag.value;
                    const newValue = !currentValue;
                    
                    // Write the toggled value back using the simple approach
                    await node.connection.controller.writeTag(tag, newValue);
                    
                    // Send result message
                    const resultMsg = {
                        ...msg,
                        payload: {
                            tag: {
                                name: tagName
                            },
                            previousValue: currentValue,
                            newValue: newValue,
                            success: true,
                            ok: true,
                            timestamp: new Date().toISOString()
                        }
                    };
                    
                    node.send(resultMsg);
                    
                    updateStatus();
                    
                } catch (error) {
                    const errorMsg = `Toggle failed: ${error && error.message ? error.message : 'Unknown error'}`;
                    node.error(errorMsg, msg);
                    node.status({fill: 'red', shape: 'ring', text: 'toggle failed'});
                    
                    // Send error message
                    const errorOutput = {
                        ...msg,
                        payload: {
                            tag: {
                                name: tagName || 'unknown'
                            },
                            error: error && error.message ? error.message : 'Unknown error occurred',
                            success: false,
                            timestamp: new Date().toISOString()
                        }
                    };
                    
                    node.send(errorOutput);
                }
            } catch (outerErr) {
                // Outer catch for validation errors
                node.error('Toggle node validation error: ' + (outerErr && outerErr.message ? outerErr.message : 'Unknown error'), msg);
            }
        });
        
        // Cleanup on node removal
        this.on('close', function() {
            if (node.connection) {
                node.connection.removeUser(node);
            }
        });
        
        // Initial status update
        updateStatus();
    }
    
    RED.nodes.registerType('eip-toggle', EIPToggleNode);
};