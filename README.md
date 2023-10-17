Ranvier telnet is an event-based telnet server and socket package with GMCP support. Telnet commands are issued as events that you can handle as you please.

## Requirements

Node >= 15+

## Usage

```javascript
const Telnet = require('ranvier-telnet');
const server = new Telnet.TelnetServer(rawSocket => {
  const telnetSocket = new Telnet.TelnetSocket();
  telnetSocket.attach(rawSocket);

  telnetSocket.on('data', data => {
    // do stuff with input
  });
}).netServer;

server.listen(4000);
```

## Expanded Example

The createServer() is an alternate to calling the TelnetServer constructor yourself and the socket returned
from the callback is already a TelnetSocket type.  Specifying the port in your options will automatically 
call the underlying listen() method.  In this example, the client will "go idle" after 5 seconds and will
start receiving warnings after being idle for 50 seconds.  This ends with a 10 second countdown before 
finally being disconnected.

```javascript
const { TelnetServer, EchoMode, LineMode } = require('ranvier-telnet');

TelnetServer.createServer(
    {
        echoMode: EchoMode.DEFAULT, // Pending linemode functionality
        expandColors: true,
        idleThreshold: 60000, //  Time
        lineMode: LineMode.DEFAULT, // Line mode functionality is incomplete, still
        timeout: 60000 * 60, //  Max timeout value
        timeoutWarning: 3600000 - 10000, //  Initial timeout warning
        timeoutWarningInterval: 1000, //  Interval between subsequent warnings
        wantGCMP: true, //  On by default since it was the original feature
        wantWindowSize: true, //  Want NAWS / window size event
        wantTerminalType: true, //  Want terminal type event
        port: 4000
    },
    async (socket) => {
        socket.write('> ');
        socket.on('terminal type', termType => {
            console.log(`Terminal type is ${termType}`);
        });
        socket.on('window size', size => {
            console.log(`Remote client has window size of ${size.height} x ${size.width}`);
        });
        socket.on('data', data => {
            socket.write(`\n\rYou sent ${data}\n\r\n\r`);
            socket.write('> ');
        });
        socket.on('idle countdown', timeLeft => {
            let secondsLeft = (timeLeft / 1000.0).toFixed(1);
            socket.write(`... You will be logged off in ${secondsLeft} seconds! \n\r`);
        });
        socket.on('idle disconnect', () => {
            socket.write(`\n\rGood-Bye!\n\r\n\r`);
        });
        socket.on('idle off', () => {
            socket.write(`\n\rYou are no longer idle.\n\r\n\r`);
        });
        socket.on('idle on', () => {
            socket.write(`\n\rYou are now idle.\n\r\n\r`);
        });
        socket.on('idle warning', timeLeft => {
            let secondsLeft = (timeLeft / 1000.0).toFixed(1);
            socket.write(`\n\rThis is your first idle warning; You will be logged off in ${secondsLeft}...\n\r`);
        });
    });
```

## Events

`<event name>(arguments)`

* `close`: Fires when the connection is closed
* `data(Buffer input)`: Stream data that is not part of an IAC sequence
* `idle off`: Occurs after a previously idle connection becomes active again.
* `idle on`: Occurs when the socket has exceeded the idle threshold (if enabled)
* `idle warning(number timeLeft)`: The initial warning send to the client of a pending timeout
* `idle countdown(number timeLeft)`: A subsequent warning of a looming timeout; Sends time left in ms.
* `idle disconnect`: Fires just prior to disconnecting the client
* `WILL/WONT/DO/DONT(number commandOpt)`: IAC command event, argument is the opt byte to the command, you can use `RanvierTelnet.Options` or your own map of options.
* `SUBNEG(number opt, Buffer buffer)`: Sent at completion of `IAC SB <OPT> [data] IAC SB` sequence. `buffer` argument is a `Buffer` of SB data
* `GMCP(string package, data)`: Sent on completion of GMCP data. See: https://www.gammon.com.au/gmcp
* `terminal type(string termName)`: Fires if the client sends its terminal type (e.g. 'ANSI', 'xterm', 'vt100', etc)
* `unknownAction(number command, number opt)`: Some unknown IAC command was given
* `window size({ width:number, height:number })`: Returns the client screen size as an object indicating rows and columns.

## GMCP

As shown above you can receive GMCP data with the `GMCP` event. To send GMCP data you can use the `sendGMCP` method:

```javascript
telnetSocket.sendGMCP('foo.bar', { some: "data" });
```

## Simple Color Support

Several MUDs had support for very simplistic color codes in text.  You may optionally enable this when creating your server.
Any string containing text like: This is %^RED%^red%^RESET%^ text will show the word "red" in the color red.

## Executing other Telnet commands

If you want to execute other telnet commands, perhaps in response to a `DO` or `DONT` you can use the `telnetCommand` method:

```javascript
// inside some class somewhere
this.useGMCP = false;

telnetSocket.on('DO', option => {
  switch (option) {
    case Telnet.Options.GMCP:
      this.useGMCP = true;
      break;
  }
});

telnetSocket.telnetCommand(Telnet.Sequences.WILL, Telnet.Options.GMCP);
```
