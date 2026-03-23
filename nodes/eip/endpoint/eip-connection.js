const { Controller, Tag } = require('st-ethernet-ip');

module.exports = function(RED) {
    class EIPConnectionNode {
        constructor(config) {
            RED.nodes.createNode(this, config);

            this.name = config.name;
            this.host = config.host;
            this.slot = parseInt(config.slot) || 0;
            this.timeout = parseInt(config.timeout) || 5000;
            this.connTimeout = parseInt(config.connTimeout) || 5000;
            this.updateRate = parseInt(config.updateRate) || 1000;
            this.reconnectTime = parseInt(config.reconnectTime) || 5000;

            // Connection state
            this.controller = null;
            this.connected = false;
            this.connecting = false;
            this.reconnectTimer = null;

            // Reference counting for connection management
            this.users = new Set();

            const node = this;

            // Global handler for st-ethernet-ip uncaught exceptions to prevent crashes
            if (!global.stEthernetIpExceptionHandler) {
                global.stEthernetIpExceptionHandler = (err) => {
                    const errorMsg = err.message || err.toString();
                    
                    // Handle st-ethernet-ip specific errors that shouldn't crash Node-RED
                    if (errorMsg.includes('SCAN_GROUP') && errorMsg.includes('TIMEOUT')) {
                        console.error('[st-ethernet-ip] Scan timeout caught, continuing operation:', errorMsg);
                        return; // Don't crash
                    }
                    
                    // Handle connection reset errors
                    if (errorMsg.includes('ECONNRESET') || errorMsg.includes('read ECONNRESET')) {
                        console.error('[st-ethernet-ip] Connection reset caught, will attempt reconnection:', errorMsg);
                        return; // Don't crash
                    }
                    
                    // Handle other network-related errors
                    if (errorMsg.includes('ENOTFOUND') || errorMsg.includes('ECONNREFUSED') || errorMsg.includes('ETIMEDOUT')) {
                        console.error('[st-ethernet-ip] Network error caught, will attempt reconnection:', errorMsg);
                        return; // Don't crash
                    }
                    
                    // Handle st-ethernet-ip specific timeouts
                    if (errorMsg.includes('Tag Group') || errorMsg.includes('st-ethernet-ip') || errorMsg.includes('Controller')) {
                        console.error('[st-ethernet-ip] Library error caught, continuing operation:', errorMsg);
                        return; // Don't crash
                    }
                    
                    // Re-throw other errors that are not st-ethernet-ip related
                    throw err;
                };
                process.on('uncaughtException', global.stEthernetIpExceptionHandler);
            }

            // Initialize connection
            this.connect = function () {
                if (node.connecting || node.connected) {
                    return Promise.resolve(node.controller);
                }

                return new Promise((resolve, reject) => {
                    try {
                        // Validate inputs first
                        if (!node.host || typeof node.host !== 'string' || node.host.trim() === '') {
                            throw new Error('Invalid host address: ' + node.host);
                        }
                        
                        if (typeof node.slot !== 'number' || node.slot < 0 || node.slot > 30) {
                            throw new Error('Invalid slot number: ' + node.slot);
                        }

                        node.connecting = true;
                        
                        // Create controller with additional error handling
                        try {
                            node.controller = new Controller();
                            
                            // Fix EventEmitter memory leak by increasing maxListeners
                            if (node.controller.setMaxListeners) {
                                node.controller.setMaxListeners(100); // Allow up to 100 listeners
                            }
                            
                            // Add error handling for connection issues
                            node.controller.on('error', (err) => {
                                const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
                                node.error(`Controller error: ${errorMessage}`);
                                node.connected = false;
                                node.scheduleReconnect();
                            });
                            
                        } catch (controllerErr) {
                            throw new Error('Failed to create Controller: ' + (controllerErr.message || controllerErr));
                        }

                        // Add connection timeout
                        const timeout = setTimeout(() => {
                            node.connected = false;
                            node.connecting = false;
                            if (node.controller) {
                                try {
                                    node.controller.destroy();
                                } catch (e) { /* ignore */ }
                                node.controller = null;
                            }
                            reject(new Error(`Connection timeout after ${node.connTimeout}ms`));
                        }, node.connTimeout);

                        // Attempt connection with proper error handling
                        node.controller.connect(node.host, node.slot).then(() => {
                            clearTimeout(timeout);
                            
                            try {
                                node.connected = true;
                                node.connecting = false;

                                // Safely set scan rate
                                try {
                                    if (node.controller.scan_rate !== undefined) {
                                        node.controller.scan_rate = node.updateRate;
                                    }
                                } catch (scanRateErr) {
                                    node.warn('Could not set scan rate: ' + scanRateErr.message);
                                }

                                node.log(`Connected to PLC at ${node.host}:${node.slot}`);



                                // Clear reconnect timer
                                if (node.reconnectTimer) {
                                    clearTimeout(node.reconnectTimer);
                                    node.reconnectTimer = null;
                                }

                                resolve(node.controller);
                            } catch (setupErr) {
                                node.connected = false;
                                node.connecting = false;
                                reject(new Error('Post-connection setup failed: ' + setupErr.message));
                            }
                            
                        }).catch((connErr) => {
                            clearTimeout(timeout);
                            node.connected = false;
                            node.connecting = false;
                            
                            // Handle different error types
                            let errorMessage = 'Connection failed';
                            if (connErr) {
                                if (connErr.message) {
                                    errorMessage += ': ' + connErr.message;
                                } else if (connErr.code) {
                                    errorMessage += ': ' + connErr.code;
                                } else if (typeof connErr === 'string') {
                                    errorMessage += ': ' + connErr;
                                }
                            }
                            
                            // Don't spam errors for common network issues
                            if (errorMessage.includes('ECONNRESET') || errorMessage.includes('ENOTFOUND') || errorMessage.includes('ECONNREFUSED')) {
                                node.warn(`Network connection lost: ${errorMessage}`);
                            } else {
                                node.error(errorMessage);
                            }
                            
                            node.scheduleReconnect();
                            reject(new Error(errorMessage));
                        });

                    } catch (initErr) {
                        node.connected = false;
                        node.connecting = false;
                        const errorMessage = 'Connection initialization failed: ' + (initErr.message || initErr);
                        node.error(errorMessage);
                        node.scheduleReconnect();
                        reject(new Error(errorMessage));
                    }
                });
            };

            this.disconnect = function () {
                // Clear reconnect timer first
                if (node.reconnectTimer) {
                    clearTimeout(node.reconnectTimer);
                    node.reconnectTimer = null;
                }

                // Disconnect controller if exists
                if (node.controller) {
                    try {
                        if (node.connected && typeof node.controller.destroy === 'function') {
                            node.controller.destroy();
                        }
                    } catch (err) {
                        node.warn('Error during disconnect: ' + (err.message || err));
                    }
                    node.controller = null;
                }

                node.connected = false;
                node.connecting = false;
            };

            this.scheduleReconnect = function () {
                if (node.reconnectTimer) {
                    clearTimeout(node.reconnectTimer);
                }

                node.reconnectTimer = setTimeout(() => {
                    if (!node.connected && !node.connecting && node.users.size > 0) {
                        node.log('Attempting to reconnect...');
                        node.connect().catch(() => {
                            // Reconnection will be rescheduled by connect failure
                        });
                    }
                }, node.reconnectTime);
            };

            // Start scanning subscription tags
            this.startScanning = function () {
                if (node.connected && node.controller && !node.controller.scanning) {
                    try {
                        // Check if there are any subscribed tags (TagGroup has tags)
                        let hasSubscriptions = false;
                        if (node.controller.state && node.controller.state.subs) {
                            // TagGroup should have a forEach method or size property
                            try {
                                node.controller.state.subs.forEach(() => {
                                    hasSubscriptions = true;
                                });
                            } catch (e) {
                                // Fallback: just try to start scanning anyway
                                hasSubscriptions = true;
                            }
                        }
                        
                        if (hasSubscriptions) {
                            node.controller.scan();
                            node.log('Started scanning tags');
                        }
                    } catch (err) {
                        const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
                        node.error('Failed to start scanning: ' + errorMessage);
                    }
                }
            };

            // Stop scanning if no more subscription nodes
            this.stopScanningIfEmpty = function () {
                if (node.connected && node.controller && node.controller.scanning) {
                    try {
                        // Check if TagGroup is empty
                        let hasSubscriptions = false;
                        if (node.controller.state && node.controller.state.subs) {
                            try {
                                node.controller.state.subs.forEach(() => {
                                    hasSubscriptions = true;
                                });
                            } catch (e) {
                                // If forEach fails, assume no subscriptions
                                hasSubscriptions = false;
                            }
                        }
                        
                        if (!hasSubscriptions) {
                            node.controller.pauseScan();
                            node.log('Stopped scanning - no active subscriptions');
                        }
                    } catch (err) {
                        const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
                        node.error('Failed to stop scanning: ' + errorMessage);
                    }
                }
            };

            // Register a node to use this connection
            this.addUser = function (user) {
                if (user) {
                    node.users.add(user);
                    if (!node.connected && !node.connecting) {
                        node.connect().catch(err => {
                            const errorMessage = err && err.message ? err.message : (err ? String(err) : 'Unknown error');
                            node.error('Failed to connect when adding user: ' + errorMessage);
                        });
                    }
                }
            };

            // Unregister a node from using this connection
            this.removeUser = function (userNode) {
                node.users.delete(userNode);
                if (node.users.size === 0) {
                    setTimeout(() => {
                        if (node.users.size === 0) {
                            node.disconnect();
                        }
                    }, 5000); // 5 second delay before disconnecting
                }
            };

            // Handle connection close
            this.on('close', function () {
                node.disconnect();
            });
        }
    }
    
    RED.nodes.registerType('eip-connection', EIPConnectionNode);
};