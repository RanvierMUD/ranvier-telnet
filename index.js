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
