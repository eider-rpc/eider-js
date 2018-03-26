/*
Copyright 2017 Semiconductor Components Industries LLC (d/b/a "ON
Semiconductor")

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/* global gc */
/* eslint-env node, mocha */

let assert = require('assert');
let Eider = require('..');

describe('Eider', function() {
    function aiter2array(it) {
        return it.then(them => {
            let xs = [];
            return Eider.forEachAsync(them, x => xs.push(x))
                .then(() => xs);
        });
    }

    class Value extends Eider.LocalObject {
        constructor(lsession, x) {
            super(lsession);
            this._x = x;
        }

        val() {
            return this._x;
        }

        set_val(x) { // eslint-disable-line camelcase
            return getValue(x).then(x => {
                this._x = x;
            });
        }

        add(x) {
            return getValue(x).then(x => {
                this._x += x;
            });
        }

        subtract(x) {
            return getValue(x).then(x => {
                this._x -= x;
            });
        }

        multiply(x) {
            return getValue(x).then(x => {
                this._x *= x;
            });
        }

        divide(x) {
            return getValue(x)
                .then(x => {
                    if (x === 0) {
                        throw new Error('Cannot divide by zero');
                    }
                    this._x /= x;
                });
        }
    }

    Value.help = 'Represents a numeric value.';
    Value.prototype.add.help = 'Add another value to the value.';

    function getValue(x) {
        // x may be a number, a local Value, or a remote Value
        return Promise.resolve(x).then(x =>
            (typeof x === 'number') ? x : x.val()
        );
    }

    class Range extends Eider.LocalObject {
        constructor(lsession, start, stop) {
            super(lsession);
            this._start = start;
            this._stop = stop;
        }

        iter() {
            return this;
        }

        next() {
            let i = this._start;
            if (i >= this._stop) {
                return {done: true};
            }
            this._start = i + 1;
            return {value: i};
        }
    }

    class Sequence extends Eider.LocalObject {
        constructor(lsession, seq) {
            super(lsession);
            this._seq = seq;
        }

        get(i) {
            if (i >= this._seq.length) {
                throw new Eider.Errors.IndexError();
            }
            return this._seq[i];
        }
    }

    class API extends Eider.LocalRoot {
        numObjects() {
            return Object.keys(this._lsession.objects).length;
        }

        call(f, ...args) {
            return f(...args);
        }

        storeCb(cb) {
            this.cb = cb;
        }

        callCb(...args) {
            return this.cb(...args);
        }

        passthru(x) {
            return x;
        }

        native(x) {
            return new NativeObject(x);
        }
    }

    Eider.LocalRoot.setNewables(API, [Value, Range, Sequence]);

    class LocalAPI extends API {
        product(...args) {
            return args.reduce((a, b) => a * b);
        }

        square(x) {
            return x * x;
        }
    }

    class RemoteAPI extends API {
        constructor(...args) {
            super(...args);
            this._cancelled = false;
        }

        sum(...args) {
            return args.reduce((a, b) => a + b);
        }

        cancellable() {
            let resolve;
            let p = new Promise(r => {
                resolve = r;
            });
            p.cancel = () => {
                this._cancelled = true;
                resolve();
            };
            return p;
        }

        cancelled() {
            return this._cancelled;
        }

        map(f, xs, async = true) {
            if (async) {
                let i = 0;
                let ys = [];
                let iter = () =>
                    (i >= xs.length)
                        ? ys
                        : f(xs[i]).then(x => {
                            ys.push(x);
                            ++i;
                            return iter();
                        });
                return iter();
            } else {
                return xs.map(f);
            }
        }

        getattr(obj, attr) {
            return Eider.using(obj, o => o[attr].bind(o));
        }

        setTarget() {
            RemoteAPI.resolveTarget(this._lsession.conn);
        }

        bridge() {
            return RemoteAPI.target
                .then(t => new Eider.Bridge(this._lsession, t));
        }
    }

    RemoteAPI.target = new Promise(resolve => {
        RemoteAPI.resolveTarget = resolve;
    });

    class TargetAPI extends API {
        join(s, xs) {
            return Array.prototype.join.call(xs, s);
        }
    }

    class NativeObject {
        constructor(x) {
            this.x = x;
        }

        add(x) {
            this.x += x;
        }

        get() {
            return this.x;
        }
    }

    function nativeFunction(s) {
        return s + ' native';
    }

    let server;
    let conn;
    let conn2;
    let lroot;
    let rroot;
    let rrootCodec;
    let rrootMsgpack;
    let broot;
    let conn3;
    let rrootBin;

    before(function() {
        return new Promise((resolve, reject) => {
            server = Eider.serve(0, {root: RemoteAPI});
            server.on('listening', () => {
                let url = 'ws://localhost:' + server._server.address().port;
                resolve(Promise.all([
                    Eider.connect(url, {
                        root: TargetAPI
                    }).then(c => {
                        conn = c;
                        return Eider.using(c.createSession(), root =>
                            root.setTarget()
                        );
                    }),

                    Eider.connect(url, {
                        root: LocalAPI
                    }).then(c => {
                        conn2 = c;
                        lroot = c.createLocalSession().root();
                        rroot = c.createSession().root();
                        rrootCodec = c.createSession('json', 'json').root();
                        rrootMsgpack =
                            c.createSession('msgpack', 'msgpack').root();
                        return rroot.bridge()
                            .then(b => {
                                broot = b.root();
                            });
                    }),

                    Eider.connect(url, {
                        lformat: 'msgpack'
                    }).then(c => {
                        conn3 = c;
                        rrootBin = c.createSession().root();
                    })
                ]));
            });
            server.on('error', reject);
        });
    });

    after(function() {
        conn.close();
        conn2.close();
        conn3.close();
        server.close();
    });

    it('call a remote method', function() {
        return rroot.sum(3, 5, 9)
            .then(x => assert.equal(x, 17));
    });

    it('cancel a remote method call', function() {
        let c = rroot.cancellable();
        setTimeout(c.cancel.bind(c), 10);
        return c
            .then(
                () => assert(false),
                exc => assert(exc instanceof Eider.Errors.CancelledError)
            )
            .then(() => rroot.cancelled())
            .then(assert);
    });

    it('call using separately-encoded message bodies', function() {
        return rrootCodec.sum(24, 10, 8)
            .then(x => assert.equal(x, 42));
    });

    it('create a remote object', function() {
        return rroot.new_Value(2)
            .then(x => x.val())
            .then(x => assert.equal(x, 2));
    });

    it('set a remote property', function() {
        return rroot.new_Value(2)
            .then(x =>
                x.set_val(4)
                    .then(() => x.val())
                    .then(x => assert.equal(x, 4))
            );
    });

    it('call a nonexistent remote method', function() {
        return rroot.foo(42)
            .then(
                () => assert(false),
                exc => assert(exc instanceof Eider.Errors.AttributeError)
            );
    });

    it('call a remote method that raises an exception', function() {
        return rroot.new_Value(42)
            .then(x => x.divide(0))
            .then(
                () => assert(false),
                exc => {
                    assert(exc instanceof Error);
                    assert.equal(exc.message, 'Cannot divide by zero');
                    assert(exc.stack.indexOf('direct cause') !== -1);
                }
            );
    });

    it('release a remote object', function() {
        return rroot.numObjects()
            .then(n =>
                Eider.using(rroot.new_Value(0), rval =>
                    rroot.numObjects().then(m =>
                        assert.equal(n + 1, m))
                ).then(() =>
                    rroot.numObjects().then(m =>
                        assert.equal(n, m))
                )
            );
    });

    it('garbage-collect a remote object', function() {
        gc();
        return rroot.numObjects()
            .then(n =>
                rroot.new_Value(0).then(rval =>
                    rroot.numObjects().then(m =>
                        assert.equal(n + 1, m))
                ).then(() => {
                    gc();
                    return rroot.numObjects().then(m =>
                        assert.equal(n, m));
                })
            );
    });

    it('try to access a remote object after it has been released', function() {
        return rroot.new_Value(42)
            .then(rval =>
                Eider.using(rval, () =>
                    rval.add(1)
                ).then(() =>
                    rval.val()
                )
            ).then(
                () => assert(false),
                exc => assert(exc instanceof Eider.Errors.LookupError)
            );
    });

    it('try to access a remote object after its session has been closed',
        function() {
            let rval;
            return Eider.using(conn.createSession(), rroot =>
                rroot.new_Value(0).then(rv => {
                    rval = rv;
                })
            ).then(() =>
                rval.val()
            ).then(
                () => assert(false),
                exc => assert(exc instanceof Eider.Errors.LookupError)
            );
        }
    );

    it('iterate over a remote object', function() {
        return aiter2array(rroot.new_Range(38, 42))
            .then(arr =>
                assert.deepEqual(arr, [38, 39, 40, 41])
            );
    });

    it('iterate over a remote sequence', function() {
        let seq = ['foo', 'baz', 99, 'eggs'];
        return aiter2array(rroot.new_Sequence(seq))
            .then(arr =>
                assert.deepEqual(arr, seq)
            );
    });

    it('get documentation for a remote object', function() {
        return rroot.new_Value(42)
            .then(x => x.help())
            .then(h => assert.equal(h, 'Represents a numeric value.'));
    });

    it('get documentation for a remote method', function() {
        return rroot.new_Value(42)
            .then(x => x.add.bind(x).help())
            .then(h => assert.equal(h, 'Add another value to the value.'));
    });

    it("list remote object's methods", function() {
        return rroot.new_Value(42)
            .then(x => x.dir())
            .then(d => assert.deepEqual(d, (
                'add addref dir divide help multiply release set_val ' +
                'signature subtract taxa val').split(/\s+/)));
    });

    it("list remote object's base classes", function() {
        return rroot.taxa()
            .then(t => assert.deepEqual(t, ['RemoteAPI', 'API']));
    });

    it('get type signature for a remote method', function() {
        return rroot.map.bind(rroot).signature()
            .then(sig =>
                assert.deepEqual(sig, {
                    'defaults': {},
                    'params': [['a', null], ['b', null], ['*args', null]],
                    'return': null
                })
            );
    });

    it('call a local method remotely, without remote post-processing',
        function() {
            return rroot.call(lroot.product.bind(lroot), 3, 5, 9)
                .then(p => assert.equal(p, 135));
        }
    );

    it('call a local method remotely, with remote post-processing', function() {
        return rroot.map(lroot.square.bind(lroot), [1, 2, 3, 4])
            .then(p => assert.deepEqual(p, [1, 4, 9, 16]));
    });

    it('call an exception-raising local method remotely, without remote ' +
        'post-processing',
        /* eslint-disable indent */
        function() {
            let v = lroot.new_Value(42);
            return rroot.call(v.divide.bind(v), 0)
                .then(
                    () => assert(false),
                    exc => assert(exc instanceof Error &&
                        exc.message === 'Cannot divide by zero')
                );
        }
        /* eslint-enable indent */
    );

    it('call an exception-raising local method remotely, with remote ' +
        'post-processing',
        /* eslint-disable indent */
        function() {
            let v = lroot.new_Value(42);
            return rroot.map(v.divide.bind(v), [3, 1, 0, 7])
                .then(
                    () => assert(false),
                    exc => assert(exc instanceof Error &&
                        exc.message === 'Cannot divide by zero')
                );
        }
        /* eslint-enable indent */
    );

    it('call a remote method remotely', function() {
        return rroot.call(rroot.sum.bind(rroot), 42, 24)
            .then(s => assert.equal(s, 66));
    });

    it('return a remote method from a remote call', function() {
        return rroot.getattr(rroot, 'sum')
            .then(sum =>
                sum(19, 10, 13)
                    .then(s => assert.equal(s, 42))
            );
    });

    it('return a local method from a remote call', function() {
        return rroot.getattr(lroot, 'product')
            .then(product => assert.equal(product(8, 5, 3), 120));
    });

    it('pass a local object to a remote call', function() {
        return Eider.using(lroot.new_Value(3), lval =>
            Eider.using(rroot.new_Value(4), rval =>
                rval.add(lval)
                    .then(() => rval.val())
                    .then(v => assert.equal(v, 7))
            )
        );
    });

    it('pass a local native object to a remote call', function() {
        let n = new NativeObject(42);
        return rroot.passthru(n).then(m => {
            assert(Object.is(n, m));
            return rroot.passthru(nativeFunction).then(m =>
                assert(Object.is(nativeFunction, m))
            );
        });
    });

    it('return a remote native object from a remote call', function() {
        return rroot.native(99).then(rn =>
            rn.add(1).then(() =>
                rn.get().then(x =>
                    assert.equal(100, x))));
    });

    it('call a native method remotely', function() {
        let n = new NativeObject(42);
        return rroot.call(n.add.bind(n), 3).then(() =>
            assert.equal(45, n.x)
        );
    });

    it('call a native function remotely', function() {
        return rroot.call(nativeFunction, 'gone').then(s =>
            assert.equal(s, 'gone native')
        );
    });

    it('call an anonymous native function remotely', function() {
        let x = [];
        return rroot.storeCb(y => x.push(y)).then(() =>
            rroot.callCb(42).then(() =>
                assert.deepStrictEqual([42], x)
            )
        );
    });

    it('call a bridged method locally', function() {
        return broot.join(' ', 'bridges    are    neat'.split(/\s+/))
            .then(s => assert.equal(s, 'bridges are neat'));
    });

    it('try to access a bridged object after its bridge has been closed',
        /* eslint-disable indent */
        function() {
            let bval;
            return Eider.using(rroot.bridge(), broot =>
                    broot.new_Value(0).then(bv => {
                        bval = bv;
                    })
                ).then(() =>
                    bval.val()
                ).then(
                    () => assert(false),
                    exc => assert(exc instanceof Eider.Errors.LookupError)
                );
        }
        /* eslint-enable indent */
    );

    it('call a bridged method that raises an exception', function() {
        return broot.new_Value(42)
            .then(x => x.divide(0))
            .then(
                () => assert(false),
                exc => assert(exc instanceof Error &&
                    exc.message === 'Cannot divide by zero')
            );
    });

    it('call a local method across a bridge', function() {
        return broot.call(lroot.product.bind(lroot), 3, 6, 2)
            .then(p => assert.equal(p, 36));
    });

    it('call a bridged method across a bridge', function() {
        return broot.call(broot.join.bind(broot), '+', 'abc')
            .then(s => assert.equal(s, 'a+b+c'));
    });

    it('call using msgpack codec', function() {
        return rrootMsgpack.sum(67, -59, 3)
            .then(x => assert.equal(x, 11));
    });

    it('pass binary data using msgpack', function() {
        let buf = new Int32Array(7);
        for (let i = 0; i < buf.length; ++i) {
            buf[i] = i;
        }
        return rrootMsgpack.passthru(buf)
            .then(x => assert.deepEqual(new Int32Array(x), buf));
    });

    it('call with msgpack as the primary format', function() {
        return rrootBin.sum(3, 14, 159)
            .then(x => assert.equal(x, 176));
    });

    it('marshal object references out of band', function() {
        return Eider.using(rrootMsgpack.new_Value(6), six =>
            Eider.using(rrootMsgpack.new_Value(11), eleven =>
                eleven.add(six)
                    .then(() => eleven.val())
                    .then(v => assert.equal(v, 17))
            )
        );
    });

    it('pass object with special "__*__" key', function() {
        // only works with out-of-band codecs
        let obj = {'__*__': 42, 'rsid': 99};
        return rrootMsgpack.passthru(obj)
            .then(x => assert.deepEqual(x, obj));
    });
});
