/**
    Copyright (c) 2017 Shawn Biddle, http://shawnbiddle.com/

    Permission is hereby granted, free of charge, to any person obtaining
    a copy of this software and associated documentation files (the
    "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to
    permit persons to whom the Software is furnished to do so, subject to
    the following conditions:

    The above copyright notice and this permission notice shall be
    included in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
    NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
    LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
    OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
    WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

    Changes made since "branching" from original by ShawnCPlus:
        * Made objects MUD emitters.
        * Added NAWS support (12/24)
        * Added TTYPE support (12/25)
*/
'use strict';

const
    net = require('net'),
    zlib = require('zlib'),
    EventEmitter = require('events');

// see: arpa/telnet.h
const Seq = {
    IAC:    255,
    DONT:   254,
    DO:     253,
    WONT:   252,
    WILL:   251,
    SB:     250,
    SE:     240,
    GA:     249,
    EOR:    239
};

exports.Sequences = Seq;

const Opts = {
    OPT_ECHO: 1,
    OPT_TTYPE: 24,
    OPT_EOR: 25,
    OPT_NAWS: 31,
    OPT_ENV: 39,
    OPT_MCP1: 85, // MCP v1 - Obsolete
    OPT_MCCP: 86, // MCP v2 http://www.zuggsoft.com/zmud/mcp.htm
    OPT_MSP: 90, // MUD Sound Protocol
    OPT_MXP: 91, // MUD eXtension Protocol
    OPT_GMCP: 201
};

exports.Options = Opts;

class TelnetSocket extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.socket = null;
        this.maxInputLength = opts.maxInputLength || 512;
        this.echoing = true;
        this.gaMode = null;

        this.mccp = false;
        this.msp = false;
        this.mxp = false;

        this.offerGMCP = opts.offerGMCP || false;
        this.offerMCP = opts.offerMCP || false;
        this.offerMSP = opts.offerMSP || false;
        this.offerMXP = opts.offerMXP || false;
    }

    get readable() {
        return this.socket.readable;
    }

    get remoteAddress() {
        return this.socket && this.socket.remoteAddress;
    }

    get writable() {
        return this.socket.writable;
    }

    address() {
        return this.socket && this.socket.address();
    }

    end(string, enc) {
        this.socket.end(string, enc);
    }

    transmit(data) {
        if (!this.socket.ended && !this.socket.finished) {
            if (this.mccp) {
                let compressedData = zlib.deflateSync(data);
                return this.socket.write(compressedData);
            }
            else {
                return this.socket.write(data);
            }
        }
    }

    /**
     * Write data to the socket.
     * @param {string|Buffer} data The data to write to the socket
     * @param {string} encoding The encoding to use
     */
    write(data, encoding = 'utf8') {
        if (!Buffer.isBuffer(data)) {
            data = Buffer.from(data, encoding);
        }

        // escape IACs by duplicating
        let iacs = 0;
        for (const val of data.values()) {
            if (val === Seq.IAC) {
                iacs++;
            }
        }

        if (iacs) {
            let b = Buffer.alloc(data.length + iacs);
            for (let i = 0, j = 0; i < data.length; i++) {
                b[j++] = data[i];
                if (data[i] === Seq.IAC) {
                    b[j++] = Seq.IAC;
                }
            }
        }

        try {
            return this.transmit(data);
        } catch (e) {
            this.emit('error', e);
        }
        return false;
    }

    setEncoding(encoding) {
        this.socket.setEncoding(encoding);
    }

    pause() {
        this.socket.pause();
    }

    resume() {
        this.socket.resume();
    }

    destroy() {
        this.socket.destroy();
    }

    /**
     * Execute a telnet command
     * @param {number}       willingness DO/DONT/WILL/WONT
     * @param {number|Array} command     Option to do/don't do or subsequence as array
     */
    telnetCommand(willingness, command) {
        let seq = [Seq.IAC, willingness];
        if (Array.isArray(command)) {
            seq.push.apply(seq, command);
        } else {
            seq.push(command);
        }

        this.transmit(Buffer.from(seq));
    }

    toggleEcho(flag) {
        this.echoing = typeof flag === 'boolean' ? flag : !this.echoing;
        this.telnetCommand(this.echoing ? Seq.WONT : Seq.WILL, Opts.OPT_ECHO);
    }

    /**
     * Send a GMCP message
     * https://www.gammon.com.au/gmcp
     *
     * @param {string} gmcpPackage
     * @param {*}      data        JSON.stringify-able data
     */
    sendGMCP(gmcpPackage, data) {
        const gmcpData = gmcpPackage + ' ' + JSON.stringify(data);
        const dataBuffer = Buffer.from(gmcpData);
        const seqStartBuffer = Buffer.from([Seq.IAC, Seq.SB, Opts.OPT_GMCP]);
        const seqEndBuffer = Buffer.from([Seq.IAC, Seq.SE]);

        this.socket.write(Buffer.concat([seqStartBuffer, dataBuffer, seqEndBuffer], gmcpData.length + 5));
    }

    attach(connection) {
        this.socket = connection;
        let inputbuf = Buffer.alloc(this.maxInputLength);
        let inputlen = 0;

        /**
         * @event TelnetSocket#error
         * @param {Error} err
         */
        connection.on('error', err => {
            if (err.code === 'ECONNRESET') {
                // Belay that order...
                return;
            }
            this.emit('error', err);
        });

        this.telnetCommand(Seq.DO, Opts.OPT_NAWS);
        this.telnetCommand(Seq.DO, Opts.OPT_TTYPE);
        if (this.offerMCP) this.telnetCommand(Seq.WILL, Opts.OPT_MCCP);
        if (this.offerMSP) this.telnetCommand(Seq.WILL, Opts.OPT_MSP);
        if (this.offerMXP) this.telnetCommand(Seq.WILL, Opts.OPT_MXP);
        this.transmit(Buffer.from("\r\n"));

        connection.on('data', (databuf) => {
            databuf.copy(inputbuf, inputlen);
            inputlen += databuf.length;

            // immediately start consuming data if we begin receiving normal data
            // instead of telnet negotiation
            if (connection.fresh && databuf[0] !== Seq.IAC) {
                connection.fresh = false;
            }

            databuf = inputbuf.slice(0, inputlen);
            // fresh makes sure that even if we haven't gotten a newline but the client
            // sent us some initial negotiations to still interpret them
            if (!databuf.toString().match(/[\r\n]/) && !connection.fresh) {
                return;
            }

            // If multiple commands were sent \r\n separated in the same packet process
            // them separately. Some client auto-connect features do this
            let bucket = [];
            for (let i = 0; i < inputlen; i++) {
                if (databuf[i] === 3) { // ctrl-c
                    continue; //eat it
                }
                if (databuf[i] !== 10) { // \n
                    bucket.push(databuf[i]);
                } else {
                    this.input(Buffer.from(bucket));
                    bucket = [];
                }
            }

            if (bucket.length) {
                this.input(Buffer.from(bucket));
            }

            inputbuf = Buffer.alloc(this.maxInputLength);
            inputlen = 0;
        });

        connection.on('close', _ => {
            /**
             * @event TelnetSocket#close
             */
            this.emit('close');
        });

        return this;
    }

    /**
     * Parse telnet input socket, swallowing any negotiations
     * and emitting clean, fresh data
     *
     * @param {Buffer} inputbuf
     *
     * @fires TelnetSocket#DO
     * @fires TelnetSocket#DONT
     * @fires TelnetSocket#GMCP
     * @fires TelnetSocket#SUBNEG
     * @fires TelnetSocket#WILL
     * @fires TelnetSocket#WONT
     * @fires TelnetSocket#data
     * @fires TelnetSocket#unknownAction
     */
    input(inputbuf) {
        // strip any negotiations
        let cleanbuf = Buffer.alloc(inputbuf.length);
        let i = 0;
        let cleanlen = 0;
        let subnegBuffer = null;
        let subnegOpt = null;

        while (i < inputbuf.length) {
            if (inputbuf[i] !== Seq.IAC) {
                cleanbuf[cleanlen++] = inputbuf[i++];
                continue;
            }

            const cmd = inputbuf[i + 1];
            const opt = inputbuf[i + 2];

            switch (cmd) {
                case Seq.DO:
                    switch (opt) {
                        case Opts.OPT_EOR:
                            this.gaMode = Seq.EOR;
                            break;

                        case Opts.OPT_MCCP:
                            this.telnetCommand(Seq.SB, [Opts.OPT_MCCP, Seq.IAC, Seq.SE]);
                            this.mccp = true;
                            break;

                        case Opts.OPT_MSP:
                            this.telnetCommand(Seq.SB, [Opts.OPT_MXP, Seq.IAC, Seq.SE ]);
                            this.msp = true;
                            break;

                        case Opts.OPT_MXP:
                            i += 2;
                            subnegOpt = inputbuf[i++];
                            subnegBuffer = Buffer.alloc(inputbuf.length - i, ' ');
                            this.mxp = true;
                            break;

                        default:
                            /**
                             * @event TelnetSocket#DO
                             * @param {number} opt
                             */
                            this.emit('DO', opt);
                            break;
                    }
                    i += 3;
                    break;

                case Seq.DONT:
                    switch (opt) {
                        case Opts.OPT_EOR:
                            this.gaMode = Seq.GA;
                            break;
                        case Opts.OPT_MCCP:
                            if (this.mcp === 2) this.mcp = 0;
                            break;
                            break;
                        default:
                            /**
                             * @event TelnetSocket#DONT
                             * @param {number} opt
                             */
                            this.emit('DONT', opt);
                    }
                    i += 3;
                    break;

                case Seq.WILL:
                    /**
                     * @event TelnetSocket#WILL
                     * @param {number} opt
                     */
                    switch (opt) {
                        case Opts.OPT_TTYPE:
                            this.telnetCommand(Seq.SB, [Opts.OPT_TTYPE, 1, Seq.IAC, Seq.SE]);
                            break;
                    }
                    this.emit('WILL', opt);
                    i += 3;
                    break;

                /* falls through */
                case Seq.WONT:
                    /**
                     * @event TelnetSocket#WONT
                     * @param {number} opt
                     */
                    this.emit('WONT', opt);
                    i += 3;
                    break;

                case Seq.SB:
                    i += 2;
                    subnegOpt = inputbuf[i++];
                    subnegBuffer = Buffer.alloc(inputbuf.length - i, ' ');

                    let sublen = 0;
                    while (inputbuf[i] !== Seq.IAC) {
                        subnegBuffer[sublen++] = inputbuf[i++];
                    }

                    switch (opt) {
                        case Opts.OPT_MXP:
                        case Opts.OPT_TTYPE:
                            {
                                let tte = {
                                    terminalType: subnegBuffer.slice(1).toString('utf8').trim()
                                };
                                if (tte.terminalType) {
                                    this.emit('terminal type', tte);
                                    if (typeof tte.terminalType !== 'undefined')
                                        this.telnetCommand(Seq.SB, [Opts.OPT_TTYPE, 1, Seq.IAC, Seq.SE]);
                                }
                            }
                            break;
                    }
                    break;

                case Seq.SE:
                    if (subnegOpt === Opts.OPT_GMCP) {
                        let gmcpString = subnegBuffer.toString().trim();
                        let [gmcpPackage, ...gmcpData] = gmcpString.split(' ');
                        gmcpData = gmcpData.join(' ');
                        gmcpData = gmcpData.length ? JSON.parse(gmcpData) : null;
                        /**
                         * @event TelnetSocket#GMCP
                         * @param {string} gmcpPackage
                         * @param {*} gmcpData
                         */
                        this.emit('GMCP', gmcpPackage, gmcpData);
                    }
                    else if (subnegOpt === Opts.OPT_NAWS) {
                        this.emit('window size', {
                            width: subnegBuffer.readInt16BE(0),
                            height: subnegBuffer.readInt16BE(2)
                        });
                    }
                    else {
                        /**
                         * @event TelnetSocket#SUBNEG
                         * @param {number} subnegOpt SB option
                         * @param {Buffer} subnegBuffer Buffer of data inside subnegotiation package
                         */
                        this.emit('SUBNEG', subnegOpt, subnegBuffer);
                    }
                    i += 2;
                    break;

                default:
                    /**
                     * @event TelnetSocket#unknownAction
                     * @param {number} cmd Command byte specified after IAC
                     * @param {number} opt Opt byte specified after command byte
                     */
                    this.emit('unknownAction', cmd, opt);
                    i += 2;
                    break;
            }
        }

        if (this.socket.fresh) {
            this.socket.fresh = false;
            return;
        }

        /**
         * @event TelnetSocket#data
         * @param {Buffer} data
         */
        this.emit('data', cleanbuf.slice(0, cleanlen - 1));
    }
}

exports.TelnetSocket = TelnetSocket;

class TelnetServer extends EventEmitter {
    /**
     * @param {function} listener   connected callback
     */
    constructor(listener) {
        super();

        this.netServer = net.createServer({}, (socket) => {
            socket.fresh = true;
            listener(socket);
        });

        this.netServer.on('error', error => {
            this.emit('error', error);
        });

        this.netServer.on('uncaughtException', error => {
            this.emit('uncaughtException', error);
        });
    }

    listen(...args) {
        return this.netServer.listen.apply(this.netServer, args);
    }
}

/**
 * @param {function} listener A callback that fires when a new connection is established.
 */
TelnetServer.createServer = function (listener) {
    return new TelnetServer(listener);
};

exports.TelnetServer = TelnetServer;

// vim:ts=2:sw=2:et:
