/*
Copyright 2017 Semiconductor Components Industries LLC (d/b/a "ON Semiconductor")

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
    
    const VERSION = '0.9.4';
    
    // Get a reference to the global context object
    let globals = typeof self === 'object' && self.self === self && self || // browser
        typeof global === 'object' && global.global === global && global || // Node.js
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
    
    let using = function(mgr, body) {
        // This provides automatic releasing of objects that represent external resources, like the
        // "with" statement in Python.
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
    if (asyncIterator === void 0) {  // expected circa ES8
        asyncIterator = Symbol('Symbol.asyncIterator');
    }
    
    // Some future ES standard will probably have 'for await'.  Till then, we provide this method.
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
    
    const OBJECT_ID = '__*__'; // Marker for marshallable object references within encoded data
    
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
    
    let isPrivate = function(name) {
        // Properties with names beginning with an underscore, or with certain special names
        // defined or used by JavaScript, cannot be accessed remotely.
        return (name.substring(0, 1) == '_' || name == 'constructor' || name == 'toJSON');
    };
    
    let getAttr = function(obj, attr) {
        let a = obj[attr];
        if (a === void 0) {
            throw new Errors.AttributeError("'" + obj.constructor.name +
                "' object has no attribute '" + attr + "'");
        }
        if (a === Object.prototype[attr]) {
            throw new Errors.AttributeError("Cannot access forbidden attribute '" + attr +
                "' of '" + obj.constructor.name + "' object");
        }
        return a;
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
    
    new Codec('json', JSON.stringify, JSON.parse);
    
    // Use `msgpack-lite` package, or fallback to global msgpack object
    let msgpack;
    try {
        msgpack = require('msgpack-lite');
    } catch (exc) {
        if (globals.msgpack !== void 0) {
            msgpack = globals.msgpack;
        }
    }
    if (msgpack !== void 0) {
        // ExtBuffer class isn't exported as of msgpack-lite 0.1.26
        // We need this because addExtPacker compares constructor names, which won't work for
        // subclasses.
        let ExtBuffer = msgpack.decode([0xd4, 0, 0]).constructor;
        
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
            if (obj instanceof ArrayBuffer || {}.toString.call(obj) === '[object ArrayBuffer]') {
                return obj;
            }
            if (ArrayBuffer.isView(obj)) {
                return obj.buffer;
            }
            return Object.keys(obj).reduce((o, k) => {
                o[k] = marshalAll(obj[k]);
                return o;
            }, {});
        };
        
        let codec = msgpack.createCodec({binarraybuffer: true});
        let options = {codec: codec};
        codec.addExtUnpacker(0, data => new Reference(msgpack.decode(data, options)));
        
        new Codec(
            'msgpack',
            data => msgpack.encode(marshalAll(data), options),
            data => msgpack.decode(data, options),
            false
        );
    }
    
    // Use `weak` package, if available
    let weak;
    try {
        weak = require('weak');
    } catch (exc) {
        // weak package is optional
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
            if (obj instanceof ArrayBuffer || {}.toString.call(obj) === '[object ArrayBuffer]') {
                return obj;
            }
            return Object.keys(obj).reduce((o, k) => {
                o[k] = this.unmarshalAllOutOfBand(obj[k], srcid);
                return o;
            }, {});
        }
        
        unmarshal(ref, srcid) {
            let obj = this.unmarshalObj(ref, srcid);
            
            if (!('method' in ref)) {
                return obj;
            }
            let method = ref.method;
            if (isPrivate(method)) {
                throw new Errors.AttributeError("Cannot access private attribute '" + method +
                    "' of '" + obj.constructor.name + "' object");
            }
            
            let f = getAttr(obj, method);
            
            // use a Proxy because f.bind(obj) doesn't preserve properties (e.g. f.help)
            return new Proxy(f, {
                apply: (target, that, args) => target.apply(obj, args)
            });
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
                // create the root last, because it may depend on the session being already set up
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
                // this is actually a remote object (a callback)
                // don't use a real RemoteSession, because we don't manage its lifetime
                let rsession = new RemoteSessionBase(this.conn, ref.lsid, null, srcid);
                rsession.lcodec = this.lcodec;
                let robj = rsession.unmarshalId(oid);
                robj._closed = true; // callbacks do not need to be released
                return robj;
            }
            
            let lsid = ref.rsid;
            if (!this.conn.lsessions.hasOwnProperty(lsid)) {
                throw new Errors.LookupError('Unknown session: ' + lsid);
            }
            
            return this.unmarshalId(oid);
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
    }
    
    class LocalObjectBase {
        
        constructor(lsession, loid) {
            this._lsession = lsession;
            this._loid = loid;
            this._lref = {lsid: lsession.lsid, [OBJECT_ID]: loid};
            this._nref = 1;
            
            // The following monstrosity allows us to pass callbacks to remote method calls in a
            // natural way, e.g.
            //    robj.f(lobj.g.bind(lobj))
            // It works by adding a toJSON() method to the bound function object that gets called
            // when it is marshalled. All other semantics of Function.prototype.bind() remain
            // untouched.
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
                                        bf.toJSON = () => ({
                                            lsid: that._lsession.lsid,
                                            [OBJECT_ID]: that._loid,
                                            method: key
                                        });
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
            return this._lref;
        }
        
        addref() {
            ++this._nref;
        }
        
        release() {
            if (!--this._nref) {
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
                    n !== arr[i + 1] && !isPrivate(n) && typeof this[n] === 'function'
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
            // TODO we might be able to fish more information out of method.toString()
            let params = [];
            const alpha = 'abcdefghijklmnopqrstuvwxyz';
            for (let i = 0; i < method.length; ++i) {
                params.push([alpha.charAt(i), null]);
            }
            params.push(['*args', null]);
            return {
                'params': params,
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
            return this;
        }
        
        _exit() {
            this.release();
        }
    }
    
    LocalObjectBase.prototype.addref.help = "Increment the object's reference count.";
    LocalObjectBase.prototype.release.help = "Decrement the object's reference count.  " +
        'When the reference count reaches zero,\nit will be removed from memory.';
    LocalObjectBase.prototype.help.help = 'Get documentation for the object or one of its ' +
        'methods.';
    LocalObjectBase.prototype.dir.help = "Get a list of names of the object's methods.";
    LocalObjectBase.prototype.taxa.help = "Get a list of names of the object's base classes.";
    LocalObjectBase.prototype.signature.help = 'Get method type signature.';
    
    class LocalRoot extends LocalObjectBase {
        
        constructor(lsession) {
            super(lsession, null);
        }
    
        _close() {
            // close all objects in session
            for (let loid in this._lsession.objects) {
                this._lsession.objects[loid]._close();
            }
            
            // remove session
            delete this._lsession.conn.lsessions[this._lsession.lsid];
        }
        
        static setNewables(cls, newables) {
            // This is the equivalent of the magic _newables member in Python. Subclasses of
            // LocalRoot can call this to automatically create new_Foo() factory functions.
            newables.forEach(C => {
                let _new = C._new; // the class can provide its own factory function
                if (_new === void 0) {
                    _new = (...args) => new C(...args);
                    _new.help = C.help;
                }
                
                (cls.prototype['new_' + C.name] = function(...args) {
                    return _new(this._lsession, ...args);
                })
                .help = _new.help;
            });
        }
    }
    
    class LocalSessionManager extends LocalRoot {
        
        open(lsid, lformat = null) {
            this._lsession.conn.createLocalSession(lsid, null, lformat);
        }
    }
    
    LocalSessionManager.prototype.open.help = 'Open a new session.';
    
    class LocalObject extends LocalObjectBase {
        constructor(lsession) {
            let loid = lsession.nextloid++;
            super(lsession, loid);
            lsession.objects[loid] = this;
        }
    }
    
    let closeRemoteObject = rdata => {
        // If the session or the connection or the bridged connection is already closed, then
        // don't throw an error, because the remote object is already dead.
        return new Promise((resolve, reject) => {
            if (rdata.closed || rdata.rsession.closed) {
                resolve(); // already closed
            } else {
                rdata.closed = true;
                let did;
                try {
                    did = rdata.rsession.call(rdata.rref, 'release');
                } catch (exc) {
                    if (exc instanceof Errors.DisconnectedError) {
                        resolve(); // direct connection is already dead
                    } else {
                        reject(exc);
                    }
                }
                if (did !== void 0) {
                    did.then(
                        resolve, // object successfully released
                        exc => {
                            if (exc instanceof Errors.DisconnectedError) {
                                resolve(); // connection (direct or bridged) is now dead
                            } else {
                                reject(exc);
                            }
                        });
                }
            }
        });
    };
    
    class RemoteObject {
        
        constructor(rsession, roid) {
            // Add an extra level of indirection so that this's state can still be referenced after
            // this itself is garbage-collected.
            let rdata = {
                rsession: rsession,
                rref: {rsid: rsession.rsid, [OBJECT_ID]: roid},
                closed: false
            };
            this._rdata = rdata;
            
            if (weak !== void 0) {
                // Automatically release the remote object upon garbage collection.
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
                    
                    // anything else resolves to a remote method call
                    let f = function(...args) {
                        // eslint-disable-next-line no-invalid-this
                        return rsession.call(this, key, args);
                    };
                    
                    // allow the method to be marshalled for use as a callback
                    f.bind = function(that, ...args) {
                        let bf = Function.prototype.bind.call(this, that, ...args);
                        bf.toJSON = () => ({
                            rsid: that._rdata.rref.rsid,
                            [OBJECT_ID]: that._rdata.rref[OBJECT_ID],
                            method: key
                        });
                        return bf;
                    };
                    
                    // sugar methods
                    f.help = () => robj.help(f.bind(robj));
                    f.signature = () => robj.signature(f.bind(robj));
                    return f;
                }
            });
        }
        
        toJSON() {
            return this._rdata.rref;
        }
        
        _close() {
            // Release the object without waiting for garbage collection. This guards against
            // double-releasing and gracefully handles dropped connections. This should normally be
            // called instead of directly calling release(). Despite the leading underscore in the
            // name, client code may call this function. The underscore merely exists to
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
                this.conn.rcalls[rcid] = {rsession: this, resolve: resolve, reject: reject};
            });
            
            // the returned Promise is cancellable (Promises derived from it by then() are not)
            rcall.cancel = () => {
                let rcall = this.conn.rcalls[rcid];
                if (rcall !== void 0) {
                    delete this.conn.rcalls[rcid];
                    this.conn.send({dst: this.dstid, cancel: rcid});
                    rcall.reject(new Errors.CancelledError());
                }
            };
            return rcall;
        }
        
        unmarshalObj(ref) {
            let oid = ref[OBJECT_ID];
            
            if ('rsid' in ref) {
                // this is actually a LocalObject (a callback) being passed back to us
                let lsid = ref.rsid;
                if (!this.conn.lsessions.hasOwnProperty(lsid)) {
                    throw new Errors.LookupError('Unknown session: ' + lsid);
                }
                let lsession = this.conn.lsessions[lsid];
                return lsession.unmarshalId(oid);
            }
            
            let rsid = ref.lsid;
            if (rsid !== this.rsid) {
                throw new Errors.LookupError('Unknown session: ' + rsid);
            }
            
            let robj = this.unmarshalId(oid);
            
            if ('bridge' in ref) {
                return this.unmarshalBridge(robj, ref.bridge);
            }
            
            return robj;
        }
        
        unmarshalBridge(bridge, spec) {
            return new BridgedSession(bridge, spec);
        }
        
        unmarshalId(roid) {
            return new RemoteObject(this, roid);
        }
    }
    
    class RemoteSessionManaged extends RemoteSessionBase {
        
        constructor(conn, rsid, lformat = null, rformat = null, dstid = null) {
            super(conn, rsid, lformat, dstid);
            
            // For efficiency, we want to allow the session to be used without having to wait first
            // to see if the call to open it was successful.  Pretty much the only way this call
            // can fail is if the connection is closed.  And any subsequent uses of the session
            // will fail loudly anyway, so we can safely swallow any exceptions here.
            Promise.resolve(this._open(rformat)).catch(() => {});
            
            this.closed = false;
            this._root = this.unmarshalId(null);
        }
        
        root() {
            return this._root;
        }
        
        close() {
            if (!this.closed) {
                this.closed = true;
                this._close();
            }
        }
    }
    
    class RemoteSession extends RemoteSessionManaged {
        
        constructor(conn, lformat = null, rformat = null) {
            super(conn, conn.nextrsid++, lformat, rformat);
        }
            
        _open(rformat) {
            return this.call(null, 'open', [this.rsid, rformat]);
        }
        
        _close() {
            return this._root._close();
        }
    }
    
    class BridgedSession extends RemoteSessionManaged {
        
        constructor(bridge, spec) {
            super(bridge._rdata.rsession.conn, spec.rsid, spec.lformat, null, spec.dst);
            this.bridge = bridge;
        }
        
        _open() {
            // the bridge automatically opens the session for us
        }
        
        _close() {
            return this.bridge._close();
        }
    }
    
    class Bridge extends LocalObject {
        
        constructor(lsession, rconn,
                    // Default formats to json rather than null because bridging peer probably
                    // doesn't need to decode and re-encode message bodies.
                    lformat = 'json', rformat = 'json') {
            super(lsession);
            this._rsession = new RemoteSession(rconn, null, rformat);
            this._lref.bridge = {dst: rconn.id, rsid: this._rsession.rsid, lformat: lformat};
        }
        
        _close() {
            this._rsession.close();
        }
    }
    
    Bridge.help = 'Bridge between clients.  Allows one client to call methods exposed by\n' +
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
            this.log = (options.log ||
                ((...args) => { console.log(...args); })); // eslint-disable-line no-console
            this.lencode = Codec.registry[options.lformat || 'json'].encode;
            this.rcodec = Codec.registry[options.rformat || 'json'];
            this.rcodecBin = Codec.registry[options.rformatBin || 'msgpack'];
            
            // connection state
            this.lsessions = {}; // local sessions
            this.lcalls = {}; // local calls
            this.rcalls = {}; // remote calls
            this.bcalls = {}; // bridged calls
            this.nextrsid = 0; // next remote session id
            this.nextrcid = 0; // next remote call id
            this.header = null; // pending message header
            this.headerRcodec = null; // rcodec used for this.header
            
            // root session
            new LocalSession(this, null, (lsession => new LocalSessionManager(lsession)));
            
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
                    if (this.header === null) {
                        let rcodec = (typeof event.data === 'string') ?
                            this.rcodec : this.rcodecBin;
                        let msg;
                        try {
                            msg = rcodec.decode(event.data);
                        } catch (exc) {
                            this.log('Invalid data received on Eider WebSocket connection:', exc);
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
        
        createLocalSession(lsid = -2, rootFactory = null, lformat = null) {
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
                            throw new Errors.AttributeError("Cannot call private method '" +
                                method + "'");
                        }
                        
                        let msg;
                        if (body === null) {
                            msg = header;
                        } else {
                            rcodec = Codec.byname(header.format);
                            msg = rcodec.decode(body);
                        }
                        
                        let [lsession, loid] = this.applyBegin(rcodec, srcid, method, msg);
                        let lcodec = lsession.lcodec;
                        try {
                            let result = this.applyFinish(
                                rcodec, srcid, method, lsession, loid, msg);
                            if (cid !== null && result && typeof result.then === 'function' &&
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
                            // unmarshalling error, or the method threw a synchronous exception
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
                                
                                rcall.resolve(this.getresult(rcodec, rcall.rsession, msg));
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
                header.src = this.id; // the callee needs to know where to send the response
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
            
            if (!this.lsessions.hasOwnProperty(lsid)) {
                throw new Errors.LookupError('Unknown session: ' + lsid);
            }
            return [this.lsessions[lsid], loid];
        }
        
        applyFinish(rcodec, srcid, method, lsession, loid, msg) {
            let lobj = lsession.unmarshalId(loid);
            let f = getAttr(lobj, method);
            let params = ('params' in msg) ? lsession.unmarshalAll(rcodec, msg.params, srcid) : [];
            return f.apply(lobj, params);
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
                    exc.stack = stack.trim() + '\n\nThe above exception was the direct cause of ' +
                        'the following exception:\n\n' + exc.stack;
                } else {
                    exc.stack = stack;
                }
            }
            throw exc;
        }
        
        onError(srcid, lcid, exc, lcodec = null) {
            if (lcid === null) {
                this.log(exc);
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
                this.rcalls[rcid].reject(new Errors.DisconnectedError('Connection lost'));
            }
            
            // dispose of outstanding bridged calls (as callee)
            for (let srcid in this.bcalls) {
                let src = this.registry.get(srcid);
                if (src !== void 0) {
                    for (let cid in this.bcalls[srcid]) {
                        src.error(null, cid,
                            new Errors.DisconnectedError('Bridged connection lost'));
                    }
                }
            }
            
            // dispose of outstanding bridged calls (as caller)
            for (let id in this.registry.objects) {
                let conn = this.registry.objects[id];
                let cids = conn.bcalls[this.id];
                if (cids !== void 0) {
                    delete conn.bcalls[this.id];
                    if (conn.ws !== null) {
                        for (let cid in cids) {
                            conn.send({cancel: cid});
                        }
                    }
                }
            }
        }
        
        sendcall(lcodec, dstid, rcid, robj, method, params = []) {
            if (this.ws === null) {
                throw new Errors.DisconnectedError('Connection closed');
            }
            
            let header = {
                dst: dstid,
                id: rcid,
                method: method
            };
            
            let body;
            if (lcodec === null) {
                body = null;
                header.this = robj;
                header.params = params;
            } else {
                body = lcodec.encode({
                    this: robj,
                    params: params
                });
                header.format = lcodec.name;
            }
            
            this.send(header, body);
        }
        
        respond(srcid, lcid, result, lcodec) {
            if (result === void 0) {
                result = null;
            }
            let header = {dst: srcid, id: lcid};
            let body;
            if (lcodec === null) {
                body = null;
                header.result = result;
            } else {
                try {
                    body = lcodec.encode({result: result});
                } catch (exc) {
                    this.error(srcid, lcid, exc, lcodec);
                    return;
                }
                header.format = lcodec.name;
            }
            this.send(header, body);
        }
        
        error(srcid, lcid, exc, lcodec = null) {
            let header = {dst: srcid, id: lcid};
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
                    body = lcodec.encode({error: error});
                    header.format = lcodec.name;
                } catch (exc) {
                    body = null;
                    header.error = error;
                }
            }
            this.send(header, body);
        }
        
        send(header, body = null) {
            if (this.ws !== null) {
                this.ws.send(this.lencode(header));
                if (body !== null) {
                    this.ws.send(body);
                }
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
        let server = new WSServer({port: port});
        server.on('connection', ws => connect(ws, options));
        return server;
    };
    
    let Eider = {
        asyncIterator: asyncIterator,
        Bridge: Bridge,
        Codec: Codec,
        connect: connect,
        Connection: Connection,
        Errors: Errors,
        forEachAsync: forEachAsync,
        LocalObject: LocalObject,
        LocalRoot: LocalRoot,
        Reference: Reference,
        Registry: Registry,
        serve: serve,
        using: using,
        VERSION: VERSION
    };
    
    if (typeof module !== 'undefined' && !module.nodeType && module.exports) {
        // Node.js
        module.exports = Eider;
    } else {
        // browser
        globals.Eider = Eider;
    }
})();
