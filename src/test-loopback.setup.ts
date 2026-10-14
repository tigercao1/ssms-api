import { Server } from 'node:net';

type Listen = (this: Server, ...args: unknown[]) => Server;

const guarded = Symbol.for('ssms.test.loopbackGuard');
const proto = Server.prototype as Server & { [guarded]?: true };

if (!proto[guarded]) {
  const original = Reflect.get(proto, 'listen') as Listen;
  const listen: Listen = function (...args) {
    const [port, host] = args;
    if (port === 0 && typeof host !== 'string') {
      throw new Error(
        "Test servers must listen on 127.0.0.1: use app.listen(0, '127.0.0.1') instead of app.init() with supertest",
      );
    }
    return Reflect.apply(original, this, args);
  };
  Reflect.set(proto, 'listen', listen);
  proto[guarded] = true;
}
