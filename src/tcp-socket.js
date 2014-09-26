// Copyright (c) 2014 Whiteout Networks

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

(function(root, factory) {
    'use strict';

    if (typeof define === 'function' && define.amd && typeof nodeRequire === 'undefined') {
        // amd
        define(['tcp-socket-tls'], factory.bind(null, navigator));
    } else if (typeof define === 'function' && define.amd && typeof nodeRequire !== 'undefined') {
        // amd under node-webkit
        define([], factory.bind(null, navigator, null, nodeRequire('net'), nodeRequire('tls')));
    } else if (typeof exports === 'object') {
        // node.js
        module.exports = factory(null, null, require('net'), require('tls'));
    } else {
        // global browser import
        navigator.TCPSocket = factory(navigator, root.TLS);
    }
}(this, function(root, TLS, net, tls) {
    'use strict';

    // the class to be implemented
    var TCPSocket = function() {
        throw new Error('Runtime does not offer TCPSockets!');
    };

    // detect runtime
    if (root && typeof io === 'undefined') {
        // check for native support
        root.TCPSocket = root.TCPSocket || root.mozTCPSocket;

        if (root.TCPSocket && typeof root.TCPSocket === "object") {
            // TCPSocket is already defined
            return root.TCPSocket;
        }
    }

    if (net && tls) {
        // node.js -> use native net/tls impl
        nodeShim();
    } else if (typeof chrome !== 'undefined' && chrome.socket) {
        // chrome packaged app
        chromeShim();
    } else if (typeof window === 'object' && typeof io === 'function') {
        // websocket proxy
        wsShim();
    }

    function nodeShim() {

        TCPSocket = function(config) {
            var self = this,
                netApi;

            config.options.useSecureTransport = (typeof config.options.useSecureTransport !== 'undefined') ? config.options.useSecureTransport : false;
            config.options.binaryType = config.options.binaryType || 'arraybuffer';

            // public flags
            self.host = config.host;
            self.port = config.port;
            self.ssl = config.options.useSecureTransport;
            self.bufferedAmount = 0;
            self.readyState = 'connecting';
            self.binaryType = config.options.binaryType;

            if (self.binaryType !== 'arraybuffer') {
                throw new Error('Only arraybuffers are supported!');
            }

            netApi = (self.ssl) ? tls : net;
            self._socket = netApi.connect(self.port, self.host, self._emit.bind(self, 'open'));

            // add all event listeners to the new socket
            self._attachListeners();
        };

        TCPSocket.prototype._attachListeners = function() {
            var self = this;

            self._socket.on('data', function(nodeBuf) {
                // convert node buffer to array buffer or string
                self._emit('data', toArrayBuffer(nodeBuf));
            });

            self._socket.on('error', function(error) {
                self._emit('error', error);
                self.close();
            });

            self._socket.on('end', self._emit.bind(self, 'close'));
        };

        TCPSocket.prototype._removeListeners = function() {
            this._socket.removeAllListeners('data');
            this._socket.removeAllListeners('end');
            this._socket.removeAllListeners('error');
        };

        //
        // API
        //

        TCPSocket.prototype.close = function() {
            this.readyState = 'closing';
            this._socket.end();
        };

        TCPSocket.prototype.send = function(data) {
            // convert data to string or node buffer
            this._socket.write(toBuffer(data), this._emit.bind(this, 'drain'));
        };

        TCPSocket.prototype.upgradeToSecure = function() {
            var self = this;

            if (self.ssl) {
                return;
            }

            // remove all event listeners from the old socket
            self._removeListeners();

            // replace the old socket with a shiny new tls socket
            self._socket = tls.connect({
                socket: self._socket
            }, function() {
                self.ssl = true;
            });

            // add all event listeners to the new socket
            self._attachListeners();
        };

        // node buffer -> array buffer
        function toArrayBuffer(buffer) {
            var view = new Uint8Array(buffer.length);
            for (var i = 0; i < buffer.length; ++i) {
                view[i] = buffer[i];
            }
            return view.buffer;
        }

        // array buffer -> node buffer
        function toBuffer(ab) {
            return new Buffer(new Uint8Array(ab));
        }

    } // end of nodeShim

    function chromeShim() {

        /**
         * TCPSocket constructor. Invoked indirectly via TCPSocket.open
         */
        TCPSocket = function(config) {
            var self = this;

            config.options.useSecureTransport = (typeof config.options.useSecureTransport !== 'undefined') ? config.options.useSecureTransport : false;
            config.options.binaryType = config.options.binaryType || 'arraybuffer';

            // public flags
            self.host = config.host;
            self.port = config.port;
            self.ssl = false;
            self.bufferedAmount = 0;
            self.readyState = 'connecting';
            self.binaryType = config.options.binaryType;

            if (self.binaryType !== 'arraybuffer') {
                throw new Error('Only arraybuffers are supported!');
            }

            // internal flags
            self._socketId = 0;
            self._ca = config.options.ca;
            self._useTLS = config.options.useSecureTransport;
            self._useSTARTTLS = false;

            // handles writes during starttls handshake, chrome socket only
            self._startTlsBuffer = [];
            self._startTlsHandshakeInProgress = false;

            // setup forge as fallback if native TLS is unavailable
            if (!chrome.socket.secure && self._useTLS) {
                // setup the forge tls client
                createTLS.bind(self)();
            }

            // connect the socket
            chrome.socket.create('tcp', {}, function(createInfo) {
                self._socketId = createInfo.socketId;

                chrome.socket.connect(self._socketId, self.host, self.port, function(result) {
                    if (result !== 0) {
                        self.readyState = 'closed';
                        self._emit('error', new Error('Unable to connect'));
                        return;
                    }

                    // do an immediate TLS handshake if self._useTLS === true
                    if (self._useTLS && chrome.socket.secure) {
                        // use native TLS stack if available
                        chrome.socket.secure(self._socketId, {}, function(tlsResult) {
                            if (tlsResult !== 0) {
                                self._emit('error', new Error('TLS handshake failed'));
                                self.close();
                                return;
                            }

                            // socket is up and running
                            self._emit('open');
                            // let's start reading
                            read.bind(self)();
                        });
                    } else if (self._useTLS) {
                        // use forge for TLS as fallback
                        self._tls.handshake();
                        // let's start reading
                        read.bind(self)();
                    } else {
                        // socket is up and running
                        self._emit('open');
                        // let's start reading
                        read.bind(self)();
                    }
                });
            });
        };

        var read = function() {
            var self = this;

            if (self._socketId === 0) {
                // the socket is closed. omit read and stop further reads
                return;
            }

            chrome.socket.read(self._socketId, function(readInfo) {
                // socket closed remotely or broken
                if (readInfo.resultCode <= 0) {
                    self._socketId = 0;
                    self.close();
                    return;
                }

                // data is available
                if ((self._useTLS || self._useSTARTTLS) && !chrome.socket.secure) {
                    // feed the data to the tls socket
                    self._tls.processInbound(readInfo.data);
                } else {
                    // emit data event
                    self._emit('data', readInfo.data);
                }

                read.bind(self)(); // start the next read
            });
        };

        //
        // API
        //

        TCPSocket.prototype.close = function() {
            this.readyState = 'closing';
            if (this._socketId !== 0) {
                chrome.socket.disconnect(this._socketId);
                chrome.socket.destroy(this._socketId);
                this._socketId = 0;
            }
            this._emit('close');
        };

        TCPSocket.prototype.upgradeToSecure = function() {
            var self = this;

            if (self.ssl || self._useSTARTTLS) {
                return;
            }

            self._useSTARTTLS = true;

            if (chrome.socket.secure) {
                chrome.socket.secure(self._socketId, {}, function(tlsResult) {
                    if (tlsResult !== 0) {
                        self._emit('error', new Error('TLS handshake failed'));
                        self.close();
                        return;
                    }

                    self.ssl = true;

                    // empty the buffer
                    while (self._startTlsBuffer.length) {
                        self.send(self._startTlsBuffer.shift());
                    }

                    // let's start reading
                    read.bind(self)();
                });
            } else {
                createTLS.bind(self)();
                self._tls.handshake();
            }
        };

        TCPSocket.prototype.send = function(buffer) {
            if ((self._useTLS || self._useSTARTTLS) && !chrome.socket.secure) {
                // give buffer to forge to be prepared for tls
                this._tls.prepareOutbound(buffer);
                return;
            } else if (this._useSTARTTLS && !this.ssl) {
                // buffer data until handshake is done
                this._startTlsBuffer.push(buffer);
                return;
            }

            this._send(buffer); // send the arraybuffer
        };

        TCPSocket.prototype._send = function(data) {
            var self = this;

            if (self._socketId === 0) {
                // the socket is closed.
                return;
            }

            chrome.socket.write(self._socketId, data, function(writeInfo) {
                if (writeInfo.bytesWritten < 0 && self._socketId !== 0) {
                    // if the socket is already 0, it has already been closed. no need to alert then...
                    self._emit('error', new Error('Could not write ' + data.byteLength + ' bytes to socket ' + self._socketId + '. Chrome error code: ' + writeInfo.bytesWritten));
                    self._socketId = 0;
                    self.close();

                    return;
                }

                self._emit('drain');
            });
        };

        // 
        // Event Handlers
        // 

        TCPSocket.prototype.oncert = function(cert) {
            this.oncert(cert);
        };

        TCPSocket.prototype.onerror = function(message) {
            this._emit('error', new Error(message));
            this.close();
        };

        TCPSocket.prototype.onclose = function() {
            this.close();
        };

        TCPSocket.prototype.onopen = function() {
            this.ssl = true;
            if (this._useTLS) {
                this._emit('open');
            }
        };

        TCPSocket.prototype.onprepared = function(buffer) {
            this._send(buffer);
        };

        TCPSocket.prototype.onprocessed = function(buffer) {
            this._emit('data', buffer);
        };

    } // end of chromeShim

    function wsShim() {

        var _socket;

        /**
         * TCPSocket constructor. Invoked indirectly via TCPSocket.open
         */
        TCPSocket = function(config) {
            var self = this;

            config.options.useSecureTransport = (typeof config.options.useSecureTransport !== 'undefined') ? config.options.useSecureTransport : false;
            config.options.binaryType = config.options.binaryType || 'arraybuffer';

            // public flags
            self.host = config.host;
            self.port = config.port;
            self.ssl = false;
            self.bufferedAmount = 0;
            self.readyState = 'connecting';
            self.binaryType = config.options.binaryType;
            self._socketId = false;

            if (self.binaryType !== 'arraybuffer') {
                throw new Error('Only arraybuffers are supported!');
            }

            // internal flags
            self._ca = config.options.ca;
            self._useTLS = config.options.useSecureTransport;
            self._useSTARTTLS = false;

            if (!_socket || _socket.destroyed) {
                _socket = io(
                    (config.options.ws && config.options.ws.url) || window.location.origin,
                    config.options.ws && config.options.ws.options
                );
            }

            // setup the forge tls client
            if (self._useTLS) {
                createTLS.bind(self)();
            }

            setTimeout(function() {
                _socket.emit('open', {
                    host: self.host,
                    port: self.port
                }, function(socketId) {
                    self._socketId = socketId;

                    if (self._useTLS) {
                        // the socket is up, do the tls handshake
                        self._tls.handshake();
                    } else {
                        // socket is up and running
                        self._emit('open');
                    }

                    _socket.on('data-' + self._socketId, function(chunk) {
                        if (self._useTLS || self._useSTARTTLS) {
                            // feed the data to the tls socket
                            self._tls.processInbound(chunk);
                        } else {
                            // emit data event
                            self._emit('data', chunk);
                        }
                    });

                    _socket.on('error-' + self._socketId, function(message) {
                        self._emit('error', new Error(message));
                    });

                    _socket.on('close-' + self._socketId, function() {
                        self._emit('close');
                    });
                });
            }, 0);
        };


        //
        // API
        //

        TCPSocket.prototype.close = function() {
            var self = this;
            this.readyState = 'closing';
            _socket.emit('end-' + self._socketId);
        };

        TCPSocket.prototype.send = function(buffer) {
            if (self._useTLS || self._useSTARTTLS) {
                // give buffer to forge to be prepared for tls
                this._tls.prepareOutbound(buffer);
                return;
            }

            // send the arraybuffer
            this._send(buffer);
        };

        TCPSocket.prototype._send = function(data) {
            var self = this;
            _socket.emit('data-' + self._socketId, data, function() {
                self._emit('drain');
            });
        };

        TCPSocket.prototype.upgradeToSecure = function() {
            var self = this;

            if (self.ssl || self._useSTARTTLS) {
                return;
            }

            self._useSTARTTLS = true;
            createTLS.bind(self)();
            self._tls.handshake();
        };


        // 
        // Event Handlers
        // 

        TCPSocket.prototype.oncert = function(cert) {
            this.oncert(cert);
        };

        TCPSocket.prototype.onerror = function(message) {
            this._emit('error', new Error(message));
            this.close();
        };

        TCPSocket.prototype.onclose = function() {
            this.close();
        };

        TCPSocket.prototype.onopen = function() {
            this.ssl = true;
            if (this._useTLS) {
                this._emit('open');
            }
        };

        TCPSocket.prototype.onprepared = function(buffer) {
            this._send(buffer);
        };

        TCPSocket.prototype.onprocessed = function(buffer) {
            this._emit('data', buffer);
        };

    } // end of wsShim

    //
    // Common API
    //

    TCPSocket.open = function(host, port, options) {
        return new TCPSocket({
            host: host,
            port: port,
            options: options || {}
        });
    };

    TCPSocket.listen = TCPSocket.listen || apiNotSupported;
    TCPSocket.prototype.resume = TCPSocket.prototype.resume || apiNotSupported;
    TCPSocket.prototype.suspend = TCPSocket.prototype.suspend || apiNotSupported;
    TCPSocket.prototype.upgradeToSecure = TCPSocket.prototype.upgradeToSecure || apiNotSupported;

    function apiNotSupported() {
        throw new Error('API not supported');
    }

    // Internal use

    // utility function, to be bound to the respective websocket & chrome.socket shim TCPSocket object
    var createTLS = function() {
        // create the tls client
        this._tls = new TLS();

        // configure the tls client
        this._tls.configure({
            host: this.host,
            ca: this._ca
        });

        // attach the handlers
        this._tls.onerror = this.onerror.bind(this);
        this._tls.oncert = this.oncert.bind(this);
        this._tls.onclose = this.onclose.bind(this);
        this._tls.onopen = this.onopen.bind(this);
        this._tls.onprepared = this.onprepared.bind(this);
        this._tls.onprocessed = this.onprocessed.bind(this);
    };

    TCPSocket.prototype._emit = function(type, data) {
        var cb;
        if (type === 'open') {
            this.readyState = 'open';
            cb = this.onopen;
        } else if (type === 'error') {
            cb = this.onerror;
        } else if (type === 'data') {
            cb = this.ondata;
        } else if (type === 'drain') {
            cb = this.ondrain;
        } else if (type === 'close') {
            this.readyState = 'closed';
            cb = this.onclose;
        }

        if (typeof cb !== 'function') {
            return;
        }

        cb({
            target: this,
            type: type,
            data: data
        });
    };

    if (root) {
        // add TCPSocket to root object
        root.TCPSocket = TCPSocket;
    }

    return TCPSocket;
}));