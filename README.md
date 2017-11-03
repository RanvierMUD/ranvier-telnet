Ranvier telnet is an event-based telnet server and socket package with GMCP support. Telnet commands are issued as events that you can handle as you please.

## Requirements

Node >= 7

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


## Events

`<event name>(arguments)`

* `data(Buffer input)`: Stream data that is not part of an IAC sequence
* `WILL/WONT/DO/DONT(number commandOpt)`: IAC command event, argument is the opt byte to the command, you can use `RanvierTelnet.Options` or your own map of options.
* `SUBNEG(number opt, Buffer buffer)`: Sent at completion of `IAC SB <OPT> [data] IAC SB` sequence. `buffer` argument is a `Buffer` of SB data
* `GMCP(string package, data)`: Sent on completion of GMCP data. See: https://www.gammon.com.au/gmcp
* `unknownAction(number command, number opt)`: Some unknown IAC command was given

## GMCP

As shown above you can receive GMCP data with the `GMCP` event. To send GMCP data you can use the `sendGMCP` method:

```javascript
telnetSocket.sendGMCP('foo.bar', { some: "data" });
```

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
