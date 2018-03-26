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

// Eider RPC

(function() {
'use strict';

const VERSION = '0.10.0';

// Get a reference to the global context object
let globals =
    // browser
    typeof self === 'object' && self.self === self && self ||
    // Node.js
    typeof global === 'object' && global.global === global && global ||
    {};

// Use built-in WebSocket object, or fallback to `ws` package
let WS = globals.WebSocket;
if (WS === void 0) {
    try {
        WS = require('ws');
    } catch (exc) {
        // ws package is optional
    }
}
let WSServer;
if (WS !== void 0) {
    WSServer = WS.Server;
    if (WSServer === void 0) {
        try {
            WSServer = require('ws').Server;
        } catch (exc) {
            // ws package is optional
        }
    }
}

// Use `weak` package, or fallback to global weak object
let weak;
try {
    weak = require('weak');
} catch (exc) {
    weak = globals.weak;
}

let using = function(mgr, body) {
    // This provides automatic releasing of objects that represent external
    // resources, like the "with" statement in Python.
    //
    // The following Python code:
    //
    //    with foo as bar:
    //        quux = yield from bar.baz()
    //        ...
    //
    // could be written like this in JavaScript:
    //
    //    using(foo, bar =>
    //        bar.baz().then(quux => {
    //            ...
    //        })
    //    ));

    return Promise.resolve(mgr).then(mgr => {
        let ctx = mgr._enter();
        let result;
        try {
            result = body(ctx);
        } catch (exc) {
            mgr._exit();
            throw exc;
        }
        return Promise.resolve(result)
            .then(result => {
                mgr._exit();
                return result;
            }, exc => {
                mgr._exit();
                throw exc;
            });
    });
};

let asyncIterator = Symbol.asyncIterator;
if (asyncIterator === void 0) { // expected circa ES8
    asyncIterator = Symbol('Symbol.asyncIterator');
}

// Some future ES standard will probably have 'for await'.  Till then, we
// provide this method.
let forEachAsync = (iterable, body) =>
    using(iterable[asyncIterator](), iterator => {
        let iterate = () =>
            iterator.next().then(x => {
                if (!x.done) {
                    return Promise.resolve(body(x.value))
                        .then(iterate);
                }
            });
        return iterate();
    });

// Marker for marshallable object references within encoded data
const OBJECT_ID = '__*__';

// Many of the following errors correspond to built-in Python exception types.
let Errors = {}; [
    'AttributeError',
    'CancelledError',
    'DisconnectedError',
    'IndexError',
    'LookupError',
    'RuntimeError'
].forEach(name => {
    class E extends Error {}
    E.prototype.name = name;
    Errors[name] = E;
});
Errors.Exception = Error;

// Modeled after Python's logging module.
const LOG_ERROR = 40;
const LOG_WARNING = 30;
const LOG_INFO = 20;
const LOG_DEBUG = 10;
const LogLevel = {
    [LOG_ERROR]: 'error',
    [LOG_WARNING]: 'warning',
    [LOG_INFO]: 'info',
    [LOG_DEBUG]: 'debug'
};

let isPrivate = function(name) {
    // Properties with names beginning with an underscore, or with certain
    // special names defined or used by JavaScript, cannot be accessed remotely.
    return (name.substring(0, 1) == '_' || name == 'constructor' ||
        name == 'toJSON');
};

let getAttr = function(obj, attr) {
    let a = obj[attr];
    if (a === void 0) {
        throw new Errors.AttributeError(
            "'" + obj.constructor.name + "' object has no attribute '" + attr +
            "'");
    }
    if (a === Object.prototype[attr]) {
        throw new Errors.AttributeError(
            "Cannot access forbidden attribute '" + attr + "' of '" +
            obj.constructor.name + "' object");
    }
    return a.bind(obj);
};

class Codec {
    constructor(name, encode, decode, inband = true) {
        this.name = name;
        this.encode = encode;
        this.decode = decode;
        this.inband = inband;
        Codec.registry[name] = this;
    }

    static byname(name) {
        if (name === null) {
            return null;
        }
        let codec = Codec.registry[name];
        if (codec === void 0) {
            throw new Errors.LookupError('Unknown format: ' + name);
        }
        return codec;
    }
}

Codec.registry = {};

new Codec(
    'json',
    (conn, data) => {
        let marshal = function(key, value) {
            switch (typeof value) {
            case 'boolean':
            case 'number':
            case 'string':
                return value;
            }
            if (value === null || Array.isArray(value)) {
                return value;
            }
            if (typeof value.toJSON === 'function') {
                return value.toJSON();
            }
            if (Object.getPrototypeOf(value).constructor === Object) {
                return value;
            }
            return conn.lsessions[-1].marshal(
                value, typeof value === 'function' ? 'call' : null);
        };
        return JSON.stringify(data, marshal);
    },
    JSON.parse
);

// Use `msgpack-lite` package, or fallback to global msgpack object
let msgpack;
try {
    msgpack = require('msgpack-lite');
} catch (exc) {
    msgpack = globals.msgpack;
}
if (msgpack !== void 0) {
    // ExtBuffer class isn't exported as of msgpack-lite 0.1.26
    // We need this because addExtPacker compares constructor names, which won't
    // work for subclasses.
    let ExtBuffer = msgpack.decode([0xd4, 0, 0]).constructor;

    let codec = msgpack.createCodec({binarraybuffer: true});
    let options = {codec};
    codec.addExtUnpacker(
        0, data => new Reference(msgpack.decode(data, options)));

    new Codec(
        'msgpack',
        (conn, data) => {
            let marshalAll = function(obj) {
                switch (typeof obj) {
                case 'boolean':
                case 'number':
                case 'string':
                    return obj;
                }
                if (obj === null) {
                    return obj;
                }
                if (Array.isArray(obj)) {
                    return obj.map(marshalAll);
                }
                if (typeof obj.toJSON === 'function') {
                    return new ExtBuffer(msgpack.encode(obj.toJSON()), 0);
                }
                if (obj instanceof ArrayBuffer ||
                        {}.toString.call(obj) === '[object ArrayBuffer]') {
                    return obj;
                }
                if (ArrayBuffer.isView(obj)) {
                    return obj.buffer;
                }
                if (Object.getPrototypeOf(obj).constructor === Object) {
                    return Object.keys(obj).reduce((o, k) => {
                        o[k] = marshalAll(obj[k]);
                        return o;
                    }, {});
                }
                return conn.lsessions[-1].marshal(
                    obj, typeof obj === 'function' ? 'call' : null);
            };
            return msgpack.encode(marshalAll(data), options);
        },
        data => msgpack.decode(data, options),
        false
    );
}

class Reference {
    constructor(ref) {
        this.ref = ref;
    }

    toJSON() {
        return this.ref;
    }
}

class Session {
    constructor(conn, lformat = null) {
        this.conn = conn;
        this.lcodec = Codec.byname(lformat);
    }

    unmarshalAll(rcodec, obj, srcid = null) {
        if (rcodec.inband) {
            return this.unmarshalAllInBand(obj, srcid);
        }
        return this.unmarshalAllOutOfBand(obj, srcid);
    }

    unmarshalAllInBand(obj, srcid = null) {
        switch (typeof obj) {
        case 'boolean':
        case 'number':
        case 'string':
            return obj;
        }
        if (obj === null) {
            return obj;
        }
        if (Array.isArray(obj)) {
            return obj.map(o => this.unmarshalAllInBand(o, srcid));
        }
        if (OBJECT_ID in obj) {
            return this.unmarshal(obj, srcid);
        }
        return Object.keys(obj).reduce((o, k) => {
            o[k] = this.unmarshalAllInBand(obj[k], srcid);
            return o;
        }, {});
    }

    unmarshalAllOutOfBand(obj, srcid = null) {
        switch (typeof obj) {
        case 'boolean':
        case 'number':
        case 'string':
            return obj;
        }
        if (obj === null) {
            return obj;
        }
        if (Array.isArray(obj)) {
            return obj.map(o => this.unmarshalAllOutOfBand(o, srcid));
        }
        if (obj instanceof Reference) {
            return this.unmarshal(obj.ref, srcid);
        }
        if (obj instanceof ArrayBuffer ||
                {}.toString.call(obj) === '[object ArrayBuffer]') {
            return obj;
        }
        return Object.keys(obj).reduce((o, k) => {
            o[k] = this.unmarshalAllOutOfBand(obj[k], srcid);
            return o;
        }, {});
    }

    unmarshal(ref, srcid) {
        let obj = this.unmarshalObj(ref, srcid);

        let method = ref.method;
        if (!method) {
            return obj;
        }
        if (isPrivate(method)) {
            throw new Errors.AttributeError(
                "Cannot access private attribute '" + method + "' of '" +
                obj.constructor.name + "' object");
        }

        return getAttr(obj, method);
    }

    _enter() {
        return this.root();
    }

    _exit() {
        this.close();
    }
}

class LocalSession extends Session {
    constructor(conn, lsid, rootFactory = null, lformat = null) {
        if (lsid in conn.lsessions) {
            throw new Errors.RuntimeError('Session ID in use: ' + lsid);
        }

        super(conn, lformat);
        this.lsid = lsid;
        this.nextloid = 0;
        this.objects = {};

        conn.lsessions[lsid] = this;
        try {
            // create the root last, because it may depend on the session being
            // already set up
            this.objects[null] = (rootFactory || conn.rootFactory)(this);
        } catch (exc) {
            delete conn.lsessions[lsid];
            throw exc;
        }
    }

    root() {
        return this.objects[null];
    }

    add(lobj) {
        let loid = this.nextloid++;
        this.objects[loid] = lobj;
        return loid;
    }

    unmarshalObj(ref, srcid) {
        let oid = ref[OBJECT_ID];

        if ('lsid' in ref) {
            // This is actually a remote object (a callback).  Don't use a real
            // RemoteSession, because we don't manage its lifetime.
            let rsession = new RemoteSessionBase(
                this.conn, ref.lsid, null, srcid);
            rsession.lcodec = this.lcodec;
            return rsession.unmarshalId(oid);
        }

        let lsession = this.conn.unmarshalLsession(ref.rsid);
        return lsession.unmarshalId(oid);
    }

    unmarshalId(loid) {
        if (!this.objects.hasOwnProperty(loid)) {
            throw new Errors.LookupError('Unknown object: ' + loid);
        }
        return this.objects[loid];
    }

    close() {
        this.root().release();
    }

    destroy() {
        for (let loid in this.objects) {
            this.objects[loid]._close();
        }
        delete this.conn.lsessions[this.lsid];
    }

    free(loid) {
        let lobj = this.unmarshalId(loid);
        lobj.release();
    }
}

class NativeSession extends LocalSession {
    marshal(obj, method) {
        let loid = this.nextloid++;
        this.objects[loid] = obj;

        return {
            [OBJECT_ID]: loid,
            lsid: this.lsid,
            method
        };
    }

    unmarshalId(loid) {
        let obj = super.unmarshalId(loid);
        return typeof obj === 'function' ? {call: {bind: () => obj}} : obj;
    }

    destroy() {
        delete this.conn.lsessions[this.lsid];
    }

    free(loid) {
        if (loid === null) {
            return super.free(null); // root
        }

        if (!this.objects.hasOwnProperty(loid)) {
            throw new Errors.LookupError('Unknown object: ' + loid);
        }
        delete this.objects[loid];
    }
}

class LocalObjectBase {
    constructor(lsession, loid) {
        this._lsession = lsession;
        this._loid = loid;
        this._lref = {lsid: lsession.lsid, [OBJECT_ID]: loid};

        // The following monstrosity allows us to pass callbacks to remote
        // method calls in a natural way, e.g.
        //    robj.f(lobj.g.bind(lobj))
        // It works by adding a toJSON() method to the bound function object
        // that gets called when it is marshalled.  It also forwards the 'help'
        // property, if any, to the bound function object.  All other semantics
        // of Function.prototype.bind() remain untouched.
        return new Proxy(this, {
            get: (target, key) => {
                let prop = target[key];
                if (typeof prop === 'function') {
                    return new Proxy(prop, {
                        get: (target2, key2) => {
                            let prop2 = target2[key2];
                            if (key2 === 'bind') {
                                return function(that, ...args) {
                                    // eslint-disable-next-line no-invalid-this
                                    let bf = prop2.call(this, that, ...args);
                                    bf.toJSON = () => {
                                        ++that._nref;
                                        return {
                                            lsid: that._lsession.lsid,
                                            [OBJECT_ID]: that._loid,
                                            method: key
                                        };
                                    };
                                    bf.help = prop.help;
                                    return bf;
                                };
                            }
                            return prop2;
                        }
                    });
                }
                return prop;
            }
        });
    }

    toJSON() {
        ++this._nref;
        return this._lref;
    }

    addref() {
        ++this._nref;
    }

    release() {
        if (--this._nref <= 0) {
            this._release();
        }
    }

    help(method = null) {
        if (method === null) {
            return this.constructor.help || null;
        }
        return method.help || null;
    }

    dir() {
        let obj = this;
        let d = [];
        while (obj !== Object.prototype) {
            d = d.concat(Object.getOwnPropertyNames(obj));
            obj = Object.getPrototypeOf(obj);
        }
        return d.sort()
            .filter((n, i, arr) =>
                n !== arr[i + 1] && !isPrivate(n) &&
                    typeof this[n] === 'function'
            );
    }

    taxa() {
        let proto = Object.getPrototypeOf(this);
        let taxa = [];
        while (proto !== null &&
                proto.constructor !== LocalRoot &&
                proto.constructor !== LocalObject) {
            taxa.push(proto.constructor.name);
            proto = Object.getPrototypeOf(proto);
        }
        return taxa;
    }

    signature(method) {
        // TODO we might be able to fish more information out of
        // method.toString()
        let params = [];
        const alpha = 'abcdefghijklmnopqrstuvwxyz';
        for (let i = 0; i < method.length; ++i) {
            params.push([alpha.charAt(i), null]);
        }
        params.push(['*args', null]);
        return {
            params,
            'defaults': {},
            'return': null
        };
    }

    _release() {
        delete this._lsession.objects[this._loid];
        this._close();
    }

    _close() {
    }

    _enter() {
        ++this._nref;
        return this;
    }

    _exit() {
        this.release();
    }
}

LocalObjectBase.prototype.addref.help =
    "Increment the object's reference count.";
LocalObjectBase.prototype.release.help =
    "Decrement the object's reference count.  " +
    'When the reference count reaches zero,\nit will be removed from memory.';
LocalObjectBase.prototype.help.help =
    'Get documentation for the object or one of its methods.';
LocalObjectBase.prototype.dir.help =
    "Get a list of names of the object's methods.";
LocalObjectBase.prototype.taxa.help =
    "Get a list of names of the object's base classes.";
LocalObjectBase.prototype.signature.help =
    'Get method type signature.';

class LocalRoot extends LocalObjectBase {
    constructor(lsession) {
        super(lsession, null);
        // root objects are born with one implicit reference
        this._nref = 1;
    }

    _close() {
        this._lsession.destroy();
    }

    static setNewables(cls, newables) {
        // This is the equivalent of the magic _newables member in Python.
        // Subclasses of LocalRoot can call this to automatically create
        // new_Foo() factory functions.
        newables.forEach(C => {
            let _new = C._new; // the class can provide its own factory function
            if (_new === void 0) {
                _new = (...args) => new C(...args);
                _new.help = C.help;
            }

            (cls.prototype['new_' + C.name] = function(...args) {
                return _new(this._lsession, ...args);
            }).help = _new.help;
        });
    }
}

class LocalSessionManager extends LocalRoot {
    open(lsid, lformat = null) {
        this._lsession.conn.createLocalSession(lsid, null, lformat);
    }

    free(lsid, loid) {
        let lsession = this._lsession.conn.unmarshalLsession(lsid);
        lsession.free(loid);
    }
}

LocalSessionManager.prototype.open.help =
    'Open a new session.';
LocalSessionManager.prototype.free.help =
    'Release the specified object, which may be a native object.';

class LocalObject extends LocalObjectBase {
    constructor(lsession) {
        let loid = lsession.nextloid++;
        super(lsession, loid);
        lsession.objects[loid] = this;
        // this object has no references until it is marshalled
        this._nref = 0;
    }
}

let closeRemoteObject = rdata => {
    // If the session or the connection or the bridged connection is already
    // closed, then don't throw an error, because the remote object is already
    // dead.
    return new Promise((resolve, reject) => {
        if (rdata.closed) {
            // object is already closed
            resolve();
        } else if (rdata.rsession.closed() || rdata.rsession.conn.closed()) {
            // session is already closed, or direct connection is already dead
            rdata.closed = true;
            resolve();
        } else {
            rdata.closed = true;
            // calling free instead of release allows native objects to be
            // unreferenced
            rdata.rsession.call(
                null, 'free', [rdata.rref.rsid, rdata.rref[OBJECT_ID]]
            ).then(
                // object successfully released
                resolve,
                exc => {
                    if (exc instanceof Errors.LookupError ||
                            exc instanceof Errors.DisconnectedError) {
                        // session is now closed, or connection (direct or
                        // bridged) is now dead
                        resolve();
                    } else {
                        // unexpected
                        reject(exc);
                    }
                });
        }
    });
};

class RemoteObject {
    constructor(rsession, roid) {
        // Add an extra level of indirection so that this's state can still be
        // referenced after this itself is garbage-collected.
        let rdata = {
            rsession,
            rref: {rsid: rsession.rsid, [OBJECT_ID]: roid},
            closed: false
        };
        this._rdata = rdata;

        if (weak !== void 0) {
            // Automatically release the remote object upon garbage collection.
            // If 'weak' is unavailable (e.g. in the browser), the user must
            // explicitly close the object (or its enclosing session) to avoid
            // remote leaks!
            weak(this, closeRemoteObject.bind(void 0, rdata));
        }

        return new Proxy(this, {
            get: (target, key, robj) => {
                let prop = target[key];
                if (prop !== void 0) {
                    return prop;
                }

                // certain names/symbols are used internally by JavaScript
                if (typeof key !== 'string' || // Symbol
                        key === 'inspect' || // console.log in Node.js
                        key === 'then' || // Promise
                        key === 'toJSON') { // JSON.stringify
                    return;
                }

                // anything else resolves to a remote method
                let f = function(...args) {
                    // eslint-disable-next-line no-invalid-this
                    return rsession.call(this, key, args);
                };

                // add special methods to the method when bound
                f.bind = function(that, ...args) {
                    let bf = Function.prototype.bind.call(this, that, ...args);

                    // allow the bound method to be marshalled for use as a
                    // callback
                    bf.toJSON = () => ({
                        rsid: that._rdata.rref.rsid,
                        [OBJECT_ID]: that._rdata.rref[OBJECT_ID],
                        method: key
                    });

                    // allow explicit resource management
                    bf.close = () => that._close();
                    bf._enter = () => bf;
                    bf._exit = () => bf.close();

                    // sugar methods
                    bf.help = () => that.help(bf);
                    bf.signature = () => that.signature(bf);
                    return bf;
                };
                return f;
            }
        });
    }

    toJSON() {
        return this._rdata.rref;
    }

    _close() {
        // Release the object without waiting for garbage collection. This
        // guards against double-releasing and gracefully handles dropped
        // connections. This should normally be called instead of directly
        // calling release(). Despite the leading underscore in the name, client
        // code may call this function. The underscore merely exists to
        // differentiate this from a remote method.
        return closeRemoteObject(this._rdata);
    }

    _enter() {
        return this;
    }

    _exit() {
        this._close();
    }

    [asyncIterator]() {
        return new RemoteIterator(this);
    }
}

class RemoteIterator {
    constructor(robj) {
        this.robj = robj;
        this.iter = -1;
    }

    [asyncIterator]() {
        return this;
    }

    next() {
        let iter = this.iter;
        if (iter === null) {
            return Promise.resolve({value: void 0, done: true});
        }

        let nextSeq = i =>
            // sequence protocol
            this.robj.get(i)
                .then(it => {
                    this.iter = i + 1;
                    return {value: it, done: false};
                }, exc => {
                    if (exc instanceof Errors.IndexError) {
                        this.iter = null;
                        return {value: void 0, done: true};
                    }
                    this.iter = null;
                    throw exc;
                });

        let nextIter = iter =>
            // iteration protocol
            iter.next()
                .then(it => {
                    if (it.done) {
                        this.iter = null;
                        iter._close();
                        return {value: void 0, done: true};
                    }
                    return {value: it.value, done: it.done};
                }, exc => {
                    this.iter = null;
                    iter._close();
                    throw exc;
                });

        if (iter === -1) {
            // first call
            return this.robj.iter()
                .then(iter => {
                    this.iter = iter;
                    return nextIter(iter);
                }, exc => {
                    if (exc instanceof Errors.AttributeError) {
                        // fallback to sequence protocol
                        this.iter = 0;
                        return nextSeq(0);
                    }
                    this.iter = null;
                    throw exc;
                });
        }

        if (typeof iter === 'number') {
            return nextSeq(iter);
        }
        return nextIter(iter);
    }

    close() {
        let iter = this.iter;
        this.iter = null;
        if (iter instanceof RemoteObject) {
            iter._close();
        }
    }

    _enter() {
        return this;
    }

    _exit() {
        this.close();
    }
}

class RemoteSessionBase extends Session {
    constructor(conn, rsid, lformat = null, dstid = null) {
        super(conn, lformat);
        this.rsid = rsid;
        this.dstid = dstid;
    }

    call(robj, method, params = []) {
        let rcid = this.conn.nextrcid++;
        this.conn.sendcall(this.lcodec, this.dstid, rcid, robj, method, params);

        let rcall = new Promise((resolve, reject) => {
            this.conn.rcalls[rcid] = {
                rsession: this, resolve, reject
            };
        });

        // the returned Promise is cancellable (Promises derived from it by
        // then() are not)
        rcall.cancel = () => {
            let rcall = this.conn.rcalls[rcid];
            if (rcall !== void 0) {
                delete this.conn.rcalls[rcid];
                let msg = {cancel: rcid};
                if (this.dstid !== null) {
                    msg.dst = this.dstid;
                }
                this.conn.send(msg);
                rcall.reject(new Errors.CancelledError());
            }
        };
        return rcall;
    }

    unmarshalObj(ref) {
        let oid = ref[OBJECT_ID];

        if ('rsid' in ref) {
            // this is actually a LocalObject (a callback) being passed back to
            // us
            let lsession = this.conn.unmarshalLsession(ref.rsid);
            return lsession.unmarshalId(oid);
        }

        let rsid = ref.lsid;
        let rsession;
        if (rsid === this.rsid) {
            rsession = this;
        } else {
            // This is actually a reference to an object in another session (or
            // a native object).  Don't use a real RemoteSession, because we
            // don't manage its lifetime.
            rsession = this.createExternalSession(
                this.conn, rsid, null, this.dstid);
            rsession.lcodec = this.lcodec;
        }

        let robj = rsession.unmarshalId(oid);

        if ('bridge' in ref) {
            return rsession.unmarshalBridge(robj, ref.bridge);
        }

        return robj;
    }

    unmarshalBridge(bridge, spec) {
        return new BridgedSession(bridge, spec);
    }

    unmarshalId(roid) {
        return new RemoteObject(this, roid);
    }

    closed() {
        return false;
    }

    createExternalSession(...args) {
        return new RemoteSessionBase(...args);
    }
}

class RemoteSessionManaged extends RemoteSessionBase {
    constructor(conn, rsid, lformat = null, rformat = null, dstid = null) {
        super(conn, rsid, lformat, dstid);

        // For efficiency, we want to allow the session to be used without
        // having to wait first to see if the call to open it was successful.
        // Pretty much the only way this call can fail is if the connection is
        // closed.  And any subsequent uses of the session will fail loudly
        // anyway, so we can safely swallow any exceptions here.
        Promise.resolve(this._open(rformat)).catch(() => {});

        this._root = this.unmarshalId(null);
    }

    root() {
        return this._root;
    }

    closed() {
        return this._root._rdata._closed;
    }
}

class RemoteSession extends RemoteSessionManaged {
    constructor(conn, lformat = null, rformat = null) {
        super(conn, conn.nextrsid++, lformat, rformat);
    }

    _open(rformat) {
        return this.call(null, 'open', [this.rsid, rformat]);
    }

    close() {
        return this._root._close();
    }
}

class BridgedSession extends RemoteSessionManaged {
    constructor(bridge, spec) {
        super(
            bridge._rdata.rsession.conn, spec.rsid, spec.lformat, null,
            spec.dst);
        this.bridge = bridge;

        // the bridge automatically closes the session for us
        this._root._closed = true;
    }

    _open() {
        // the bridge automatically opens the session for us
    }

    close() {
        return this.bridge._close();
    }

    closed() {
        return this.bridge._rdata._closed;
    }
}

class Bridge extends LocalObject {
    // Default formats to json rather than null because bridging peer probably
    // doesn't need to decode and re-encode message bodies.
    constructor(lsession, rconn, lformat = 'json', rformat = 'json') {
        super(lsession);
        this._rsession = new RemoteSession(rconn, null, rformat);
        this._lref.bridge = {
            dst: rconn.id, rsid: this._rsession.rsid, lformat
        };
    }

    _close() {
        this._rsession.close();
    }
}

Bridge.help =
    'Bridge between clients.  Allows one client to call methods exposed by ' +
    'another client.';

class Registry {
    constructor() {
        this.objects = {};
        this.nextid = 0;
    }

    add(obj) {
        let id = this.nextid++;
        this.objects[id] = obj;
        return id;
    }

    get(id) {
        return this.objects[id];
    }

    remove(id) {
        delete this.objects[id];
    }
}

let globalRegistry = new Registry();

class Connection {
    constructor(whither, options = {}) {
        if (options.rootFactory) {
            this.rootFactory = options.rootFactory;
        } else {
            let Root = options.root || LocalRoot;
            this.rootFactory = lsession => new Root(lsession);
        }

        this.onopen = options.onopen || (() => {});
        this.onclose = options.onclose || (() => {});
        this.logfn = (options.log ||
            ((level, ...args) => {
                // eslint-disable-next-line no-console
                console.log(LogLevel[level] || 'Unknown', ...args);
            }));
        this.logLevel = options.logLevel === void 0 ?
            LOG_WARNING : options.logLevel;
        this.lencode = Codec.registry[options.lformat || 'json'].encode;
        this.rcodec = Codec.registry[options.rformat || 'json'];
        this.rcodecBin = Codec.registry[options.rformatBin || 'msgpack'];

        // connection state
        this.lsessions = {}; // local sessions
        this.lcalls = {}; // local calls
        this.rcalls = {}; // remote calls
        this.bcalls = {}; // bridged calls
        this.nextlsid = -2; // next local session id
        this.nextrsid = 0; // next remote session id
        this.nextrcid = 0; // next remote call id
        this.header = null; // pending message header
        this.headerRcodec = null; // rcodec used for this.header

        // root session
        new LocalSession(
            this, null, (lsession => new LocalSessionManager(lsession)));

        // native (non-LocalObject) session
        new NativeSession(this, -1, (lsession => new LocalRoot(lsession)));

        // register the connection
        if (options.registry) {
            this.registry = options.registry;
        } else {
            this.registry = globalRegistry;
        }
        this.id = this.registry.add(this);

        let ws = (typeof whither === 'string') ? new WS(whither) : whither;

        // the websocket might be already closed
        if (ws.readyState === 3) {
            this.ws = null;
            this.registry.remove(this.id);

            // client expects to be notified asynchronously
            setTimeout(() => this.onclose(this), 0);
        } else {
            this.ws = ws;

            // the websocket might be already open
            if (ws.readyState === 1) {
                // client expects to be notified asynchronously
                setTimeout(() => this.onopen(this), 0);
            } else {
                ws.onopen = () => {
                    this.onopen(this);
                };
            }

            ws.onclose = () => {
                // clear connection state
                this.ws = null;
                this.lclose();
                this.rclose();

                // notify client code
                this.onclose(this);
            };

            ws.onmessage = event => {
                this.log(LOG_DEBUG, 'recv', event.data);
                if (this.header === null) {
                    let rcodec = (typeof event.data === 'string') ?
                        this.rcodec : this.rcodecBin;
                    let msg;
                    try {
                        msg = rcodec.decode(event.data);
                    } catch (exc) {
                        this.log(LOG_ERROR, 'Invalid data received on Eider ' +
                            'WebSocket connection:', exc);
                        this.close();
                        return;
                    }

                    if ('format' in msg && msg.format !== null) {
                        this.header = msg;
                        this.headerRcodec = rcodec;
                    } else {
                        this.dispatch(rcodec, msg);
                    }
                } else {
                    this.dispatch(this.headerRcodec, this.header, event.data);
                    this.header = null;
                }
            };
        }
    }

    closed() {
        return this.ws === null || this.ws.readyState !== 1;
    }

    createLocalSession(lsid = null, rootFactory = null, lformat = null) {
        if (lsid === null) {
            lsid = this.nextlsid--;
        }
        return new LocalSession(this, lsid, rootFactory, lformat);
    }

    createSession(lformat = null, rformat = null) {
        return new RemoteSession(this, lformat, rformat);
    }

    dispatch(rcodec, header, body = null) {
        let dstid = header.dst;
        if (dstid === void 0) {
            dstid = null;
        }
        let method = header.method;
        if (method) {
            // this is a call
            let cid = header.id;
            if (cid === void 0) {
                cid = null;
            }
            if (dstid === null) {
                let srcid = header.src;
                if (srcid === void 0) {
                    srcid = null;
                }
                try {
                    if (isPrivate(method)) {
                        throw new Errors.AttributeError(
                            "Cannot call private method '" + method + "'");
                    }

                    let msg;
                    if (body === null) {
                        msg = header;
                    } else {
                        rcodec = Codec.byname(header.format);
                        msg = rcodec.decode(body);
                    }

                    let [lsession, loid] = this.applyBegin(
                        rcodec, srcid, method, msg);
                    let lcodec = lsession.lcodec;
                    try {
                        let result = this.applyFinish(
                            rcodec, srcid, method, lsession, loid, msg);
                        if (cid !== null && result &&
                                typeof result.then === 'function' &&
                                typeof result.cancel === 'function') {
                            // this is a cancellable call
                            this.lcalls[cid] = result;
                        }
                        Promise.resolve(result)
                            .then(result => {
                                if (cid !== null) {
                                    if (cid in this.lcalls) {
                                        delete this.lcalls[cid];
                                    }
                                    this.respond(srcid, cid, result, lcodec);
                                }
                            })
                            .catch(exc => {
                                // the method threw an asynchronous exception
                                if (cid in this.lcalls) {
                                    delete this.lcalls[cid];
                                }
                                this.onError(srcid, cid, exc, lcodec);
                            });
                    } catch (exc) {
                        // unmarshalling error, or the method threw a
                        // synchronous exception
                        this.onError(srcid, cid, exc, lcodec);
                    }
                } catch (exc) {
                    // failed before the lcodec could be determined
                    this.onError(srcid, cid, exc);
                }
            } else {
                this.bridgeCall(dstid, cid, header, body);
            }
        } else {
            let cancelid = header.cancel;
            if (cancelid !== void 0 && cancelid !== null) {
                // this is a cancel request
                if (dstid === null) {
                    let lcall = this.lcalls[cancelid];
                    if (lcall !== void 0) {
                        delete this.lcalls[cancelid];
                        lcall.cancel();
                    }
                } else {
                    this.bridgeCall(dstid, null, header, body);
                }
            } else {
                // this is a response
                let cid = header.id;
                if (dstid === null) {
                    let rcall = this.rcalls[cid];
                    if (rcall !== void 0) {
                        delete this.rcalls[cid];
                        try {
                            let msg;
                            if (body === null) {
                                msg = header;
                            } else {
                                rcodec = Codec.byname(header.format);
                                msg = rcodec.decode(body);
                            }

                            rcall.resolve(this.getresult(
                                rcodec, rcall.rsession, msg));
                        } catch (exc) {
                            rcall.reject(exc);
                        }
                    }
                } else {
                    this.bridgeResponse(dstid, cid, header, body);
                }
            }
        }
    }

    bridgeCall(dstid, cid, header, body) {
        let dst = this.registry.get(dstid);
        if (dst === void 0) {
            this.onError(null, cid,
                new Errors.DisconnectedError('Unknown connection: ' + dstid));
        } else {
            // forward message to intended callee
            delete header.dst; // no further forwarding
            header.src = this.id; // tell callee where to send the response
            dst.send(header, body);

            if (cid !== null) {
                (dst.bcalls[this.id] || (dst.bcalls[this.id] = {}))[cid] = 1;
            }
        }
    }

    bridgeResponse(dstid, cid, header, body) {
        let dst = this.registry.get(dstid);
        if (dst !== void 0) {
            if (this.bcalls[dstid] && this.bcalls[dstid][cid]) {
                delete this.bcalls[dstid][cid];
            }

            // forward response to caller
            delete header.dst; // no further forwarding
            dst.send(header, body);
        }
    }

    unmarshalLsession(lsid) {
        if (!this.lsessions.hasOwnProperty(lsid)) {
            throw new Errors.LookupError('Unknown session: ' + lsid);
        }
        return this.lsessions[lsid];
    }

    applyBegin(rcodec, srcid, method, msg) {
        let lref = msg.this;
        let loid;
        let lsid;
        if (lref === void 0 || lref === null) {
            loid = null;
            lsid = null;
        } else if (Array.isArray(lref)) {
            throw new TypeError('Malformed this object');
        } else {
            if (lref instanceof Reference) {
                lref = lref.ref;
            }
            loid = lref[OBJECT_ID];
            if (loid === void 0) {
                loid = null;
            }
            lsid = lref.rsid;
            if (lsid === void 0) {
                lsid = null;
            }
        }

        return [this.unmarshalLsession(lsid), loid];
    }

    applyFinish(rcodec, srcid, method, lsession, loid, msg) {
        let lobj = lsession.unmarshalId(loid);
        let f = getAttr(lobj, method);
        let params = ('params' in msg) ?
            lsession.unmarshalAll(rcodec, msg.params, srcid) : [];
        return f(...params);
    }

    getresult(rcodec, rsession, msg) {
        if ('result' in msg) {
            return rsession.unmarshalAll(rcodec, msg.result);
        }

        let error = msg.error;
        if (!error) {
            throw new Error('Unspecified error');
        }

        // attempt to unmarshal error object; fallback to generic Error
        let message = error.message;
        if (message === void 0 || message === '') {
            message = 'Unspecified error';
        } else {
            message = '' + message;
        }
        let name = '' + error.name;
        let Etype = Errors[name] || globals[name];
        if (!(typeof Etype === 'function' &&
                (Etype === Error || Etype.prototype instanceof Error))) {
            Etype = Error;
            if (name) {
                message = name + ': ' + message;
            }
        }
        let stack = error.stack;
        let exc = new Etype(message);
        if (typeof stack === 'string') {
            if (typeof exc.stack === 'string') {
                exc.stack = stack.trim() + '\n\nThe above exception was the ' +
                    'direct cause of the following exception:\n\n' + exc.stack;
            } else {
                exc.stack = stack;
            }
        }
        throw exc;
    }

    onError(srcid, lcid, exc, lcodec = null) {
        if (lcid === null) {
            this.log(LOG_ERROR, exc);
        } else {
            if (exc.name === void 0 || exc.message === void 0) {
                exc = new Error(exc);
            }
            this.error(srcid, lcid, exc, lcodec);
        }
    }

    close() {
        if (this.ws !== null) {
            this.ws.close();
            this.ws = null;
            this.registry.remove(this.id);
        }
    }

    lclose() {
        for (let lsid in this.lsessions) {
            this.lsessions[lsid].objects[null]._release();
        }
    }

    rclose() {
        this.registry.remove(this.id);

        // cancel any outstanding local calls
        for (let lcid in this.lcalls) {
            this.lcalls[lcid].cancel();
        }

        // dispose of outstanding remote calls
        for (let rcid in this.rcalls) {
            this.rcalls[rcid].reject(
                new Errors.DisconnectedError('Connection lost'));
        }

        // dispose of outstanding bridged calls (as callee)
        for (let srcid in this.bcalls) {
            let src = this.registry.get(srcid);
            if (src !== void 0) {
                for (let cid in this.bcalls[srcid]) {
                    src.error(
                        null, cid,
                        new Errors.DisconnectedError(
                            'Bridged connection lost'));
                }
            }
        }

        // dispose of outstanding bridged calls (as caller)
        for (let id in this.registry.objects) {
            let conn = this.registry.objects[id];
            let cids = conn.bcalls[this.id];
            if (cids !== void 0) {
                delete conn.bcalls[this.id];
                if (!conn.closed()) {
                    for (let cid in cids) {
                        conn.send({cancel: cid});
                    }
                }
            }
        }
    }

    sendcall(lcodec, dstid, rcid, robj, method, params = []) {
        if (this.closed()) {
            throw new Errors.DisconnectedError('Connection closed');
        }

        let header = {id: rcid, method};
        if (dstid !== null) {
            header.dst = dstid;
        }

        let body;
        if (lcodec === null) {
            body = null;
            header.this = robj;
            header.params = params;
        } else {
            body = lcodec.encode(this, {
                this: robj,
                params
            });
            header.format = lcodec.name;
        }

        this.send(header, body);
    }

    respond(srcid, lcid, result, lcodec) {
        if (result === void 0) {
            result = null;
        }
        let header = {id: lcid};
        if (srcid !== null) {
            header.dst = srcid;
        }
        let body;
        if (lcodec === null) {
            body = null;
            header.result = result;
        } else {
            try {
                body = lcodec.encode(this, {result});
            } catch (exc) {
                this.error(srcid, lcid, exc, lcodec);
                return;
            }
            header.format = lcodec.name;
        }
        this.send(header, body);
    }

    error(srcid, lcid, exc, lcodec = null) {
        let header = {id: lcid};
        if (srcid !== null) {
            header.dst = srcid;
        }
        let error = {name: exc.name, message: exc.message};
        if (typeof exc.stack === 'string') {
            error.stack = exc.stack;
        }
        let body;
        if (lcodec === null) {
            body = null;
            header.error = error;
        } else {
            try {
                body = lcodec.encode(this, {error});
                header.format = lcodec.name;
            } catch (exc) {
                body = null;
                header.error = error;
            }
        }
        this.send(header, body);
    }

    send(header, body = null) {
        if (!this.closed()) {
            this.sendData(this.lencode(this, header));
            if (body !== null) {
                this.sendData(body);
            }
        }
    }

    sendData(data) {
        this.log(LOG_DEBUG, 'send', data);
        this.ws.send(data);
    }

    log(level, ...args) {
        if (level >= this.logLevel) {
            this.logfn(level, ...args);
        }
    }

    _enter() {
        return this;
    }

    _exit() {
        this.close();
    }
}

let connect = function(whither, options = {}) {
    return new Promise((resolve, reject) => {
        let conn = new Connection(whither, options);
        let onclose = options.onclose || (() => {});
        conn.onopen = conn => {
            conn.onclose = onclose;
            resolve(conn);
        };
        conn.onclose = conn => {
            reject(new Error('Could not connect'));
            onclose(conn);
        };
    });
};

let serve = function(port, options = {}) {
    let server = new WSServer({port});
    server.on('connection', ws => connect(ws, options));
    return server;
};

let Eider = {
    asyncIterator,
    Bridge,
    Codec,
    connect,
    Connection,
    Errors,
    forEachAsync,
    LocalObject,
    LocalRoot,
    LOG_ERROR,
    LOG_WARNING,
    LOG_INFO,
    LOG_DEBUG,
    Reference,
    Registry,
    serve,
    using,
    VERSION
};

if (typeof module !== 'undefined' && !module.nodeType && module.exports) {
    // Node.js
    module.exports = Eider;
} else {
    // browser
    globals.Eider = Eider;
}
})();
