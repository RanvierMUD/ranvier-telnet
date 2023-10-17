<<<<<<< HEAD
'use strict';

const EventEmitter = require('events');
const net = require('net');
const { isAsyncFunction } = require('util/types');

const EchoMode = Object.freeze({
    /** Do whatever the default behavior is */
    DEFAULT: 0,

    /** The client is responsible for echoing characters */
    CLIENT: 1,

    /** The client should not echo characters, the server will do that */
    SERVER: 2
});

// see: arpa/telnet.h
const Seq = Object.freeze({
    IAC: 255,
    DONT: 254,
    DO: 253,
    WONT: 252,
    WILL: 251,
    SB: 250,
    SE: 240,
    GA: 249,
    EOR: 239,
});

const SLC = Object.freeze({
    /** Sync */
    SLC_SYNCH: 1,
    /** Break */
    SLC_BRK: 2,
    /** Interupt Process */
    SLC_IP: 3,
    /** Abort Output */
    SLC_AO: 4,
    /** Are you there? */
    SLC_AYT: 5,
    /** End of Record */
    SLC_EOR: 6,
    /** Abort */
    SLC_ABORT: 7,
    /** End of File */
    SLC_EOF: 8,
    /** Suspend */
    SLC_SUSP: 9,
    /** Erase character*/
    SLC_EC: 10,
    /** Erase line */
    SLC_EL: 11,
    /** Erase word*/
    SLC_EW: 12,
    /** Reprint line */
    SLC_RP: 13,
    /** Literal next character */
    SLC_LNEXT: 14,
    /** Start output */
    SLC_XON: 15,
    /** Stop output */
    SLC_XOFF: 16,
    /** Forwarding character 1; Forces all buffered characters to be sent */
    SLC_FORW1: 17,
    /** Forwarding character 2; Forces all buffered characters to be sent */
    SLC_FORW2: 18,

    NAMES: [
        'ERROR', //  Should not exist
        'SLC_SYNCH',  'SLC_BRK',   'SLC_IP',
        'SLC_AO',     'SLC_AYT',   'SLC_EOR',
        'SLC_ABORT',  'SLC_EOF',   'SLC_SUSP',
        'SLC_EC',     'SLC_EL',    'SLC_EW',
        'SLC_RP',     'SLC_LNEXT', 'SLC_XON',
        'SLC_XOFF',   'SLC_FORW1', 'SLC_FORW2',
    ],

    /**
     * Converts a modifier flagset into a human readable string
     * @param {any} n
     * @returns
     */
    MODIFIER: (n) => {
        if (n === SLC.SLC_NOSUPPORT)
            return 'NOSUPPORT';

        let flags = [];

        if ((n & SLC.SLC_CANTCHANGE) > 0)
            flags.push('CANTCHANGE');
        if ((n & SLC.SLC_VALUE) > 0)
            flags.push('VALUE');
        if ((n & SLC.SLC_DEFAULT) > 0)
            flags.push('DEFAULT');
        if ((n & SLC.SLC_FLUSHOUT) > 0)
            flags.push('FLUSHOUT');
        if ((n & SLC.SLC_FLUSHIN) > 0)
            flags.push('FLUSHIN');

        return flags.join(' | ');
    },

    SLC_NOSUPPORT: 0,
    SLC_CANTCHANGE: 1,
    SLC_VALUE: 2,
    SLC_DEFAULT: 3,
    SLC_LEVELBITS: 3,
    SLC_FLUSHOUT: 32,
    SLC_FLUSHIN: 64,
    SLC_ACK: 128
})

const Opts = Object.freeze({
    OPT_ECHO: 1,
    OPT_TTYPE: 24,     // RFC 1091: https://www.rfc-editor.org/rfc/rfc1091.html
    OPT_EOR: 25,
    OPT_NAWS: 31,      // RFC 1073: https://www.rfc-editor.org/rfc/rfc1073.html
    OPT_LINEMODE: 34,  // RFC 1116: https://datatracker.ietf.org/doc/html/rfc1116#section-1
    OPT_GMCP: 201,
});

/**
 * Line Mode per RFC 1116 [https://datatracker.ietf.org/doc/html/rfc1116#section-1]
 */
const LineMode = Object.freeze({
    /** Do not do line mode */
    DISABLED: -1,

    /**  Unspecified -- use Default settings which varies by port number with Port 23 being special */
    DEFAULT: 0,

    /** 
     * The client should process input and only send completed lines to the
     * server; If unset then all characters are sent to the server for processing.
     */
    EDIT: 0x01,

    /**  
     * Client should convert signals into a Telnet equivelant, 
     * e.g. Ctrl-C might become ABORT or BRK */
    TRAPSIG: 0x02,

    /**  Used to confirm the current line mode */
    MODE_ACK: 0x04,

    /** Expand tabs into spaces to reach the next tabstop */
    SOFT_TAB: 0x08,

    /** 
     * When set, if the client side is echoing a non-printable character that
     * the user has typed to the user’s screen, the character should be echoed
     * as the literal character. 
     */
    LIT_ECHO: 0x10,

    /**
     * Returns a MODE that is valid
     * @param {number} mode The mode setting to mask
     * @param {boolean} isAck Should only be true when confirming MODE between client/server
     * @returns
     */
    ValidMask: (mode, isAck = false) => {
        if (typeof mode !== 'number')
            return LineMode.DEFAULT;
        else if (mode === -1)
            return -1;
        else if (isAck)
            return (mode & 31);
        else
            return (mode & 27);
    }
});

const ANSI = (c) => {
    let s = c.toString(),
        r = [27, 91];

    for (var i = 0; i < s.length; i++) {
        r.push(s.charCodeAt(i));
    }
    r.push(109);
    return Buffer.from(new Uint8Array(r)).toString('utf8');
};

const ESC = (c) => {
    let s = c.toString(),
        r = [27];

    for (var i = 0; i < s.length; i++) {
        r.push(s.charCodeAt(i));
    }
    return Buffer.from(new Uint8Array(r)).toString('utf8');
}

const TerminalColors = {
    ansi: {
        'B_BLACK': ANSI(40),
        'B_BLUE': ANSI(44),
        'B_CYAN': ANSI(46),
        'B_GREEN': ANSI(42),
        'B_MAGENTA': ANSI(45),
        'B_ORANGE': ANSI(43),
        'B_RED': ANSI(41),
        'B_WHITE': ANSI(47),
        'RESET': ANSI(0),
        'BOLD': ANSI(1),
        'BLACK': ANSI(30),
        'RED': ANSI(31),
        'BLUE': ANSI(34),
        'CYAN': ANSI(36),
        'MAGENTA': ANSI(35),
        'ORANGE': ANSI(33),
        'RESET': ANSI("0"),
        'YELLOW': ANSI(1) + ANSI(33),
        'GREEN': ANSI(32),
        'WHITE': ANSI(37),
        'CLEARLINE': ESC('[L') + ESC('[G'),
        'INITTERM': ESC("[H") + ESC("[2J")
    },
    unknown: {
        'RESET': '',
        'BOLD': '',
        'BLACK': '',
        'RED': '',
        'BLUE': '',
        'CYAN': '',
        'MAGENTA': '',
        'ORANGE': '',
        'YELLOW': '',
        'GREEN': '',
        'WHITE': ''
    },
    xterm: {
        'RESET': ANSI(0),
        'CLEARLINE': ESC('[L') + ESC('[G'),
        'B_BLACK': ANSI(40),
        'B_BLUE': ANSI(44),
        'B_CYAN': ANSI(46),
        'B_GREEN': ANSI(42),
        'B_MAGENTA': ANSI(45),
        'B_ORANGE': ANSI(43),
        'B_RED': ANSI(41),
        'B_WHITE': ANSI(47),
        'BOLD': ANSI(1),
        'BLACK': ANSI(30),
        'RED': ANSI(31),
        'BLUE': ANSI(34),
        'CYAN': ANSI(36),
        'MAGENTA': ANSI(35),
        'ORANGE': ANSI(33),
        'YELLOW': ANSI(1) + ANSI(33),
        'GREEN': ANSI(32),
        'WHITE': ANSI(37),
        'INITTERM': ESC("[H") + ESC("[2J")
    }
};
class TelnetSocketOptions {
    /**
     * Options for the TelnetSocket as provided by the server that created it
     * @param {TelnetSocketOptions} opts
     */
    constructor(opts) {
        /**
         * Who is responsible for echoing input characters.
         * @type {number}
         */
        this.echoMode = typeof opts.echoMode === 'number' ? opts.echoMode : EchoMode.DEFAULT;

        /**
         * Expand MudOS/FluffOS-style color codes?
         */
        this.expandColors = opts.expandColors === true;

        /**
         * How long until a connection is considered idle?
         */
        this.idleThreshold = opts.idleThreshold;

        /**
         * @type {number} 
        */
        this.lineMode = LineMode.ValidMask(opts.lineMode)

        /** 
         * @type {number} 
         */
        this.maxInputLength = opts.maxInputLength;

        /**
         * Max idle time in ms
         */
        this.timeout = opts.timeout;

        /** 
         * If set then warnings will be trigger alerting the socket/code of the impending timeout
         */
        this.timeoutWarning = typeof opts.timeoutWarning === 'number' && opts.timeoutWarning > 0 ? opts.timeoutWarning : false;

        /** 
         * How often should the timeout warning event fire?
         */
        this.timeoutWarningInterval = typeof opts.timeoutWarningInterval === 'number' && opts.timeoutWarningInterval > 0 ? opts.timeoutWarningInterval : false;

        /**
         *  @type {boolean} 
         */
        this.wantGCMP = opts.wantGCMP === true;

        /**
         *  @type {boolean} 
         */
        this.wantTerminalType = opts.wantTerminalType === true;

        /**
         *  @type {boolean} 
         */
        this.wantWindowSize = opts.wantWindowSize === true;
    }
}

const NativeTelnetSocketEvents = [
    'DO', 'DONT', 'WILL', 'WONT', 'SB', 'terminal type', 'window size',
    // these are emitted by both TelnetSocket and the underlying socket
    'data', 'close' 
];

class TelnetSocket extends EventEmitter {
    /**
     * 
     * @param {TelnetSocketOptions} opts
     */
    constructor(opts = {}) {
        super();

        if (false === opts instanceof TelnetSocketOptions)
            opts = new TelnetSocketOptions(opts);

        this.socket = null;
        this.lineMode = opts.lineMode;
        this.localCharacters = [];
        this.expandColors = opts.expandColors;
        this.maxInputLength = opts.maxInputLength || 512;
        this.wantTerminalType = opts.wantTerminalType === true;
        this.wantWindowSize = opts.wantWindowSize === true;
        this.echoMode = opts.echoMode || EchoMode.DEFAULT;
        this.echoing = true;
        /** @type {TelnetSocketOptions} */
        this.options = opts;
        this.terminalType = 'unknown';
        this.gaMode = null;
    }

    get readable() {
        return this.socket.readable;
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

    doExpandColors(data) {
        if (typeof data !== 'string') {
            if (Buffer.isBuffer(data)) {
                data = data.toString('utf8');
            }
        }
        let chunks = data.split(/\%\^([a-zA-Z0-9\_]+)\%\^/);
        if (chunks.length > 1) {
            let lookup = this.getColorMap(),
                multicolor = chunks
                    .map(chunk => (chunk in lookup ? lookup[chunk] : chunk))
                    .join('');
            return multicolor;
        }
        return data;
    }

    /**
     * Gets a client-specific color code translation mapping
     * @returns
     */
    getColorMap() {
        if (!this.terminalType || this.terminalType === 'unknown')
            return TerminalColors.unknown;
        else if (this.terminalType === 'linux' || this.terminalType === 'xterm')
            return TerminalColors.xterm;
        else
            return TerminalColors.ansi;
    }

    write(data, encoding) {
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
            if (!this.socket.ended && !this.socket.finished) {
                if (this.expandColors) {
                    this.socket.write(this.doExpandColors(data));
                }
                else {
                    this.socket.write(data);
                }
            }
        } catch (e) {
            this.emit('error', e);
        }
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
     * @param {...number} args Option to do/don't do or subsequence as array
     */
    telnetCommand(...args) {
        let seq = [Seq.IAC];
        args.forEach(arg => {
            //  Backwards compatibility
            if (Array.isArray(arg))
                seq.push(...arg);
            else
                seq.push(arg);
        });
        if (seq.length === 1)
            throw 'Call to telnetCommand is missing parameter';
        this.socket.write(Buffer.from(seq));
    }

    toggleEcho() {
        this.echoing = !this.echoing;
        if (this.echoMode !== EchoMode.SERVER) {
            this.telnetCommand(this.echoing ? Seq.WONT : Seq.WILL, Opts.OPT_ECHO);
        }
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
        const seqEndBuffer = new Buffer.from([Seq.IAC, Seq.SE]);

        this.socket.write(Buffer.concat([seqStartBuffer, dataBuffer, seqEndBuffer], gmcpData.length + 5));
    }

    /**
     * Attach the underlying socket
     * @param {net.Socket} connection
     * @returns
     */
    attach(connection) {
        this.resetTimers();
        const originalEmitter = connection.emit;

        connection.emit = (...args) => {
            let eventName = args[0] || '';

            //  Intercept socket events and pass them off as our own
            if (NativeTelnetSocketEvents.indexOf(eventName) === -1) {
                this.emit(...args);
            }
            originalEmitter.call(connection, ...args);
        };


        this.socket = connection;
        let inputbuf = Buffer.alloc(this.maxInputLength);
        let inputlen = 0;

        /**
         * @event TelnetSocket#error
         * @param {Error} err
         */
        connection.on('error', err => this.emit('error', err));

        if (this.wantTerminalType)
            this.telnetCommand(Seq.DO, Opts.OPT_TTYPE);
        if (this.wantWindowSize)
            this.telnetCommand(Seq.DO, Opts.OPT_NAWS);
        if (this.lineMode !== LineMode.DEFAULT) {
            this.telnetCommand(Seq.DO, Opts.OPT_LINEMODE);
            if (this.lineMode === LineMode.DISABLED)
                this.telnetCommand(Seq.SB, Opts.OPT_LINEMODE, 1, 0, Seq.IAC, Seq.SE);
        }
        if (this.echoMode === EchoMode.SERVER)
            this.telnetCommand(Seq.DONT, Opts.OPT_ECHO);

        this.socket.write("\r\n");
        connection.on('data', (databuf) => {
            databuf.copy(inputbuf, inputlen);
            inputlen += databuf.length;

            // immediately start consuming data if we begin receiving normal data
            // instead of telnet negotiation
            if (connection.fresh && databuf[0] !== Seq.IAC) {
                connection.fresh = false;
            }
            if (this.echoMode === EchoMode.SERVER) {
                if (databuf[0] !== Seq.IAC && databuf.length === 1)
                    this.write(databuf);
            }

            databuf = this.slice(inputbuf, 0, inputlen);
            // fresh makes sure that even if we haven't gotten a newline but the client
            // sent us some initial negotiations to still interpret them
            if (!databuf.toString().match(/[\r\n]/) && !connection.fresh) {
                return;
            }

            // If multiple commands were sent \r\n separated in the same packet process
            // them separately. Some client auto-connect features do this
            let bucket = [];
            for (let i = 0; i < inputlen; i++) {
                if (databuf[i] !== 10 && databuf[i] !== 13) { // neither LF nor CR
                    bucket.push(databuf[i]);
                } else {
                    // look ahead to see if our newline delimiter is part of a combo.
                    if (i + 1 < inputlen && (databuf[i + 1] === 10 || databuf[i + 1 === 13])
                        && databuf[i] !== databuf[i + 1]) {
                        i++;
                    }
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
                if (inputbuf[i] < 32) { // Skip any freaky control codes.
                    i++;
                } else {
                    cleanbuf[cleanlen++] = inputbuf[i++];
                }
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
                        case Opts.OPT_NAWS:
                            this.telnetCommand(this.wantWindowSize ? Seq.DO : Seq.DONT, Opts.OPT_NAWS);
                            break;
                        case Opts.OPT_LINEMODE:
                            if (this.lineMode === LineMode.DISABLED)
                                this.telnetCommand(Seq.SB, Opts.OPT_LINEMODE, 1, 0, Seq.IAC, Seq.SE);
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
                        case Opts.OPT_LINEMODE:
                            this.lineMode = LineMode.DEFAULT;
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
                    if (opt === Opts.OPT_TTYPE) {
                        //  Tell client to send terminal type
                        this.telnetCommand(Seq.SB, Opts.OPT_TTYPE, 1, Seq.IAC, Seq.SE);
                    }
                    else if (opt === Opts.OPT_LINEMODE) {
                        if (this.lineMode === LineMode.DISABLED)
                            this.telnetCommand(Seq.SB, Opts.OPT_LINEMODE, 1, 0, Seq.IAC, Seq.SE);
                    }

                    /**
                     * @event TelnetSocket#WILL
                     * @param {number} opt
                     */
                    this.emit('WILL', opt);
                    i += 3;
                    break;

                case Seq.WONT:
                    switch (opt) {
                        case Opts.OPT_TTYPE:
                            if (this.wantTerminalType)
                                this.emit('terminal type', 'unknown');
                            break;

                        case Opts.OPT_LINEMODE:
                            //  Client does not want to negotiate line mode (like Windows telnet)
                            this.lineMode = LineMode.DEFAULT;
                            break;
                    }
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

                    switch (opt) {
                        case Opts.OPT_TTYPE:
                            {
                                let sublen = 0;
                                while (inputbuf[i] !== Seq.IAC && i < inputbuf.length) {
                                    subnegBuffer[sublen++] = inputbuf[i++];
                                }
                                this.terminalType = this.slice(subnegBuffer, 1)
                                    .toString()
                                    .trim();
                                this.emit('terminal type', this.terminalType);
                            };
                            i += 2;
                            break;
                        case Opts.OPT_NAWS:
                            {
                                let sublen = 0;
                                while (inputbuf[i] !== Seq.IAC && i < inputbuf.length) {
                                    subnegBuffer[sublen++] = inputbuf[i++];
                                }
                                let termSize = {
                                    width: subnegBuffer.readInt16BE(0),
                                    height: subnegBuffer.readInt16BE(2)
                                };
                                this.emit('window size', termSize);
                            }
                            break;
                        case Opts.OPT_LINEMODE:
                            {
                                try {
                                    let sublen = 0, localChars = [];
                                    while (inputbuf[i] !== Seq.IAC && i < inputbuf.length) {
                                        subnegBuffer[sublen++] = inputbuf[i++];
                                    }
                                    // First byte should be SLC (Set Local Characters)
                                    if (subnegBuffer[0] === 0x03) {
                                        this.localCharacters = [];
                                        for (let n = 4; n < subnegBuffer.length; n += 3) {
                                            let localChar = {
                                                func: subnegBuffer[n],
                                                mods: subnegBuffer[n + 1],
                                                char: subnegBuffer[n + 2],
                                                word: SLC.NAMES[subnegBuffer[n]] || 'ERROR',
                                                text: SLC.MODIFIER(subnegBuffer[n + 1])
                                            }
                                            this.localCharacters.push(localChar);
                                        }
                                    }
                                    // Acknowledge the characters
                                    this.telnetCommand(Seq.SB, )
                                }
                                catch (err) {
                                    console.log(`Error negotiating line mode: ${err}`);
                                }
                            }
                            break;

                        default:
                            this.emit('SB', opt);
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
        let output = this.slice(cleanbuf, 0, cleanlen >= cleanbuf.length ? undefined : cleanlen);
        try {
            this.emit('data', output);  // special processing required for slice() to work.
        }
        finally {
            this.resetTimers();
        }
    }

    resetTimers() {
        const getTicks = () => new Date().getTime();
        let nowTicks = getTicks(),
            idleThreshold = this.options.idleThreshold,
            wasIdle = idleThreshold > 0 && (nowTicks - this.lastInputTime) > idleThreshold;

        this.lastInputTime = nowTicks;

        if (this.options.timeout > 0) {
            if (this.logoutTimer)
                clearTimeout(this.logoutTimer);

            this.logoutTimer = setTimeout(() => {
                this.emit('idle disconnect');
                this.destroy();
            }, this.options.timeout);

            if (this.options.timeoutWarning > 0) {
                if (this.logoutWarning)
                    clearTimeout(this.logoutWarning);

                this.logoutWarning = setTimeout(() => {
                    this.emit('idle warning', this.options.timeout - (getTicks() - this.lastInputTime));

                    if (this.options.timeoutWarningInterval) {
                        if (this.warningInterval)
                            clearInterval(this.warningInterval);

                        this.warningInterval = setInterval(() => {
                            this.emit('idle countdown', this.options.timeout - (getTicks() - this.lastInputTime));
                        }, this.options.timeoutWarningInterval);
                    }
                }, this.options.timeoutWarning);
            }
        }

        if (this.options.idleThreshold > 0) {
            if (this.idlingTimer)
                clearTimeout(this.idlingTimer);

            this.idlingTimer = setTimeout(() => {
                //  User is considered idle, now
                this.emit('idle on');
            }, this.options.idleThreshold);
        }

        //  If the user was previously idle, notify that they are idle no longer
        if (wasIdle) {
            this.emit('idle off');
        }
    }

    /**
     * 
     * @param {Buffer} buf
     * @param {number} start
     * @param {number?} [end]
     * @returns {Uint8Array}
     */
    slice(buf, start, end = undefined) {
        return Uint8Array.prototype.slice.call(buf, start, end);
    }
}

class TelnetServerOptions {
    /**
     * Options for the TelnetServer type
     * @param {TelnetServerOptions} opts
     */
    constructor(opts) {
        /**
         * The optional address to bind (if not using the default)
         * @type {number}
         */
        this.address = typeof opts.address === 'string' ? opts.address : undefined;

        /**
         * 
         * @type {number}
         */
        this.backlog = typeof opts.backlog === 'number' && opts.backlog > 0 ? opts.backlog : undefined;

        /**
         * Indicates who is responsible for echoing characters
         * @type {number}
         */
        this.echoMode = typeof opts.echoMode === 'number' ? opts.echoMode : EchoMode.DEFAULT;

        /** 
         * Expand %^COLOR%^ expressions when writing?
         * @type {boolean}
         */
        this.expandColors = typeof opts.expandColors === 'boolean' ? opts.expandColors : false;

        /**
         * How long until client is considered idle?
         */
        this.idleThreshold = typeof opts.idleThreshold === 'number' && opts.idleThreshold > 0 ? opts.idleThreshold : 0;

        /**
         * If specified, this tells clients which linemode we would like to use.
         * @type {number}
         */
        this.lineMode = LineMode.ValidMask(opts.lineMode);

        this.listeningListener = typeof opts.listeningListener === 'function' && opts.listeningListener;

        /**
         * Maximum input capacity of the client buffer
         * @type {number}
         */
        this.maxInputLength = typeof opts.maxInputLength === 'number' && opts.maxInputLength > 1 ? opts.maxInputLength : 512;

        /**
         * This is the TCP port we are listening to
         * @type {number}
         */
        this.port = typeof opts.port === 'number' && opts.port > 0 ? opts.port : 0;

        /** 
         * Options to pass down to the underlying net.Server object
         * @type {net.ServerOpts} 
         */
        this.socketOptions = typeof opts.socketOptions === 'object' ? opts.socketOptions : {};

        /**
         * Max idle time in ms; 0 indicates disabled
         * @type {number}
         */
        this.timeout = opts.timeout;

        /** 
         * If set then warnings will be trigger alerting the socket/code of the impending timeout
         * @type {number}
         */
        this.timeoutWarning = typeof opts.timeoutWarning === 'number' && opts.timeoutWarning > 0 ? opts.timeoutWarning : false;

        /** 
         * How often should the timeout warning event fire?
         * @type {number}
         */
        this.timeoutWarningInterval = typeof opts.timeoutWarningInterval === 'number' && opts.timeoutWarningInterval > 0 ? opts.timeoutWarningInterval : false;

        /**
         * Wants Generic Mud Communication Protocol
         */
        this.wantGCMP = opts.wantGCMP === true;

        /**
         * If this flag is set, then the client SHOULD send terminal type (e.g. xterm, ansi, vt100, etc)
         * @type {boolean}
         */
        this.wantTerminalType = opts.wantTerminalType === true;

        /**
         * If this flag is set, then the client SHOULD send window size events
         * @type {boolean}
         */
        this.wantWindowSize = opts.wantWindowSize === true;
    }

    getClientOptions(overrides = {}) {
        return new TelnetSocketOptions(Object.assign({
            echoMode: this.echoMode,
            expandColors: this.expandColors,
            idleThreshold: this.idleThreshold,
            lineMode: this.lineMode,
            maxInputLength: this.maxInputLength,
            timeout: this.timeout,
            timeoutWarning: this.timeoutWarning,
            timeoutWarningInterval: this.timeoutWarningInterval,
            wantGCMP: this.wantGCMP,
            wantTerminalType: this.wantTerminalType,
            wantWindowSize: this.wantWindowSize
        }, overrides));
    }
}

/**
 * TelnetServer wraps a net.Server object and acts as a method/event proxy
 */
class TelnetServer extends EventEmitter {
    /**
     * @param {function(TelnetSocket):void} listener          connected callback
     * @param {TelnetServerOptions} opts   Server options
     */
    constructor(listener, opts = {}) {
        super();

        this.#options = opts = opts instanceof TelnetServerOptions ? opts : new TelnetServerOptions(opts);
        const instance = this.#netServer = net.createServer(Object.assign({}, opts.socketOptions),
            async (socket) => {
                if (isAsyncFunction(listener))
                    await listener(socket);
                else
                    listener(socket);
            });
    }

    address() {
        this.netServer.address();
    }

    close(...args) {
        this.netServer.close(...args);
    }

    /**
     * 
     * @param {TelnetServerOptions} [options]
     * @param {function(TelnetSocket)} listener
     * @returns
     */
    static createServer(options, listener) {
        let serverOptions = new TelnetServerOptions(Object.assign(
            {
                backlog: undefined,
                lineMode: LineMode.DEFAULT,
                idleThreshold: 60000,
                listeningListener: undefined,
                port: 0,
                socketOptions: {},
                wantGCMP: true,
                wantTerminalType: true,
                wantWindowSize: false
            }, typeof options === 'object' ? options : {}));


        if (!listener && typeof options === 'function')
            listener = options;

        let instance = new TelnetServer(async (socket) => {
            try {
                let clientSocket = new TelnetSocket(opts.getClientOptions())
                    .attach(socket);
                this.emit('connection', clientSocket);
                socket.fresh = true;

                if (isAsyncFunction(listener))
                    await listener(clientSocket);
                else
                    listener(clientSocket);
            }
            catch (err) {
                this.emit('error', err);
                throw err;
            }
        }, serverOptions);

        if (serverOptions.port > 0) {
            instance.listen(serverOptions.port, serverOptions.address, serverOptions.backlog, serverOptions.listeningListener)
        }

        return instance;
    }

    getConnections(...args) {
        this.netServer.getConnections(...args);
    }

    /**
     * Listen to the port
     * @param {number} [port]
     * @param {string} [hostname]
     * @param {number} [backlog]
     * @param {function:void} [listeningListener]
     */
    listen(...args) {
        if (!this.listening) {
            this.netServer.listen(...args);
        }
    }

    /**
     * @see net.
     */
    get listening() {
        return this.netServer.listening;
    }

    get maxConnections() {
        return this.netServer.maxConnections;
    }

    set maxConnections(val) {
        this.netServer.maxConnections = val;
    }

    /** @type {net.Server} */
    #netServer;

    /** Backwards compatibility */
    get netServer() {
        return this.#netServer;
    }

    /** @type {TelnetServerOptions} */
    #options;

    get options() {
        return Object.assign({}, this.#options);
    }

    get server() {
        return this.#netServer;
    }
}

module.exports = { TelnetServer, TelnetServerOptions, TelnetSocket, TelnetSocketOptions, Sequences: Seq, Options: Opts, LineMode };

// vim:ts=2:sw=2:et:
=======
'use strict';

const EventEmitter = require('events');
const net = require('net');

// see: arpa/telnet.h
const Seq = {
  IAC     : 255,
  DONT    : 254,
  DO      : 253,
  WONT    : 252,
  WILL    : 251,
  SB      : 250,
  SE      : 240,
  GA      : 249,
  EOR     : 239,
};

exports.Sequences = Seq;

const Opts = {
  OPT_ECHO: 1,
  OPT_EOR : 25,
  OPT_GMCP: 201,
}

exports.Options = Opts;

class TelnetSocket extends EventEmitter
{
  constructor(opts = {}) {
    super();
    this.socket = null;
    this.maxInputLength = opts.maxInputLength || 512;
    this.echoing = true;
    this.gaMode = null;
  }

  get readable() {
    return this.socket.readable;
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

  write(data, encoding) {
    if (!Buffer.isBuffer(data)) {
      data = new Buffer(data, encoding);
    }

    // escape IACs by duplicating
    let iacs = 0;
    for (const val of data.values()) {
      if (val === Seq.IAC) {
        iacs++;
      }
    }

    if (iacs) {
      let b = new Buffer(data.length + iacs);
      for (let i = 0, j = 0; i < data.length; i++) {
        b[j++] = data[i];
        if (data[i] === Seq.IAC) {
          b[j++] = Seq.IAC;
        }
      }
    }

    try {
      if (!this.socket.ended && !this.socket.finished) {
        this.socket.write(data);
      }
    } catch (e) {
      this.emit('error', e);
    }
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

    this.socket.write(new Buffer(seq));
  }

  toggleEcho() {
    this.echoing = !this.echoing;
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
    const seqStartBuffer = new Buffer([Seq.IAC, Seq.SB, Opts.OPT_GMCP]);
    const seqEndBuffer = new Buffer([Seq.IAC, Seq.SE]);

    this.socket.write(Buffer.concat([seqStartBuffer, dataBuffer, seqEndBuffer], gmcpData.length + 5));
  }

  attach(connection) {
    this.socket = connection;
    let inputbuf = new Buffer(this.maxInputLength);
    let inputlen = 0;

    /**
     * @event TelnetSocket#error
     * @param {Error} err
     */
    connection.on('error', err => this.emit('error', err));

    this.socket.write("\r\n");
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
        if (databuf[i] !== 10 && databuf[i] !== 13) { // neither LF nor CR
          bucket.push(databuf[i]);
        } else {
          // look ahead to see if our newline delimiter is part of a combo.
          if (i+1 < inputlen && (databuf[i+1] === 10 || databuf[i+1 === 13])
            && databuf[i] !== databuf[i+1]) {
            i++;
          }
          this.input(Buffer.from(bucket));
          bucket = [];
        }
      }

      if (bucket.length) {
        this.input(Buffer.from(bucket));
      }

      inputbuf = new Buffer(this.maxInputLength);
      inputlen = 0;
    });

    connection.on('close', _ => {
      /**
       * @event TelnetSocket#close
       */
      this.emit('close');
    });
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
        if (inputbuf[i] < 32) { // Skip any freaky control codes.
          i++;
        } else {
          cleanbuf[cleanlen++] = inputbuf[i++];
        }
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
          } else {
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
    this.emit('data', cleanbuf.slice(0, cleanlen >= cleanbuf.length ? undefined : cleanlen));  // special processing required for slice() to work.
  }
}

exports.TelnetSocket = TelnetSocket;

class TelnetServer
{
  /**
   * @param {object}   streamOpts options for the stream @see TelnetSocket
   * @param {function} listener   connected callback
   */
  constructor(listener) {
    this.netServer = net.createServer({}, (socket) => {
      socket.fresh = true;
      listener(socket);
    });
  }
}

exports.TelnetServer = TelnetServer;

// vim:ts=2:sw=2:et:
>>>>>>> 0a39dd2ab9d4243b3464f4a56d5a9831827f4d71
