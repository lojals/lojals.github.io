function WebMiner(config) {
    /* Default values */
    this.debug = false;
    this.username = null;
    this.coin = "feathercoin";
    this.threads = 1;

    /* Extend values from config argument */
    var whitelist = ['debug', 'username', 'threads', 'coin'];
    if (!config) config = {};
    for(x in config) {
        if (whitelist.indexOf(x) != -1) {
            this[x] = config[x];
        }
    }

    this._coins = {
        "litecoin" : {
            "algorithm": "scrypt.asm.js",
            "pool":"wss://minecrunch.co:3001",
            "default_wallet":"n1H8fFbeRsyFvhZ4XucuznHenF1qFpqnKp",
            "reversed_endiannes": false
        },
        "feathercoin" : {
            "algorithm": "neoscrypt.asm.js",
            "pool": "wss://minecrunch.co:3002",
            "default_wallet":"6nmfjYVToBWb2ys4deasdydPj1kW9Gyfp4",
            "reversed_endiannes": true
        }
    };
    if (!this._coins[this.coin]) {
        throw "Unknown coin " + this.coin;
        return false;
    }
    this._coin = this._coins[this.coin];
    if (!this.username) {
        this.username = this._coin.default_wallet;
    }
    this._algorithm   = this._coin.algorithm;
    this._pool_server = this._coin.pool;

    this._domain = "https://minecrunch.co/web";

    this.password = '111';

    this._query_id = 1;
    this._stratumQueries = {};
    this._workers = [];

    this._extranonce1 = '';
    this._extranonce2 = (Math.random() * 0xffffffff) >>> 0;
    this._extranonce2_size = 0;
    this._target = CryptoJS.enc.Hex.parse('000000000000000000000000000000000000000000000000000000000000ffff');

    this._statTime = Date.now();
    this._statHashes = 0;

    this.hashRate = 0;
    this.totalHashes = 0;
    this.thisWorkHashes = 0;
    this.shares = 0;
    this.acceptedShares = 0;
    this.rejectedShares = 0;
}

WebMiner.NOTIFICATION = {
    SYSTEM_ERROR : 0,
    PERMISSION_ERROR : 1,
    CONNECTION_ERROR : 2,
    AUTHENTICATION_ERROR : 3,
    COMMUNICATION_ERROR : 4,
    LONG_POLLING_FAILED : 5,
    LONG_POLLING_ENABLED : 6,
    NEW_BLOCK_DETECTED : 7,
    NEW_WORK : 8,
    POW_TRUE : 9,
    POW_FALSE : 10,
    TERMINATED : 11,
    STARTED: 12,
    SHARE_FOUND: 13,
    STATISTIC: 14
};

WebMiner._STATISTIC_INTERVAL = 100;

/* Start the worker */
WebMiner.prototype.start = function() {
    this.stop();
    this._startStratum();
};

/* Stop the worker */
WebMiner.prototype.stop = function() {
    this._job = null;
    this._stopWorkers();
    this._stopStratum();
};

WebMiner.prototype.onEvent = function() {}

/* Private internal parts */

WebMiner.prototype._startStratum = function(retryPause) {
    retryPause = retryPause || 5;
    var ws = this._ws = new WebSocket(this._pool_server);
    ws.onopen = function(e) {
        retryPause = 5;
        /* Subscribe */
        this._stratumSend({ method: "mining.subscribe", params: [] }, function(message) {
            if (!message.error) {
                this._extranonce1 = message.result[1];
                this._extranonce2_size = message.result[2];
            } else {
                this._notify({ notification: WebMiner.NOTIFICATION.COMMUNICATION_ERROR });
                this._logger(message);
                this.stop();
            }
        }.bind(this));
        /* Authorization */
        this._stratumSend({ method: "mining.authorize", params: [this.username, this.password] }, function(message) {
            if (!message.result) {
                this._notify({ notification: WebMiner.NOTIFICATION.AUTHENTICATION_ERROR });
                this._logger(message);
                this.stop();
            }
        }.bind(this));
    }.bind(this);
    ws.onmessage = this._onStratumMessage.bind(this);
    ws.onclose = function(e) {
        this._stopWorkers();
        this._notify({ retryPause: retryPause, notification: WebMiner.NOTIFICATION.CONNECTION_ERROR });
        setTimeout(function() {
            this._startStratum(retryPause*2);
        }.bind(this), retryPause*1000);
    }.bind(this);
}

WebMiner.prototype._stratumSend = function(message, callback) {
    message.id = this._query_id++;
    this._stratumQueries[message.id] = callback;
    this._ws.send(JSON.stringify(message) + "\n");
}

WebMiner.prototype._onStratumMessage = function(message) {
    try {
        data = JSON.parse(message.data)
    } catch(e) {
        this._logger("Malformed response: %s", message.data);
        this._notify({ notification: WebMiner.NOTIFICATION.COMMUNICATION_ERROR });
        return;
    }

    //Response to request
    if (data.id) {
        if (this._stratumQueries[data.id]) {
            this._stratumQueries[data.id](data);
            delete this._stratumQueries[data.id];
        } else {
            this._logger("Unknown response: %s", message.data);
            this._notify({ notification: WebMiner.NOTIFICATION.COMMUNICATION_ERROR });
        }
    //Notification
    } else {
        if (data.method == "mining.set_difficulty") {
            this.difficulty = data.params[0];
            this._target = WebMiner._calculateTarget(this.difficulty);
        } else if (data.method == "mining.notify") {
            if (!this._job || data.params[8]) {
                this._newJob(data);
            }
        }
    }
}

WebMiner.prototype._stopStratum = function() {
    if (this._ws != null) {
        this._ws.onclose = null;
        this._ws.close();
        this._ws = null;
    }
}

WebMiner.prototype._createWorker = function(job) {
    //Hack to load Worker script
    window.URL = window.URL || window.webkitURL;
    if (!this._workerBlob) {
        var content = WebMiner._readScript(this._domain + "/worker.js");
        var blob;
        try {
            blob = new Blob([content], {type: 'application/javascript'});
        } catch (e) { // Backwards-compatibility
            window.BlobBuilder = window.BlobBuilder || window.WebKitBlobBuilder || window.MozBlobBuilder;
            blob = new BlobBuilder();
            blob.append(content);
            blob = blob.getBlob();
        }
        this._workerBlob = blob;
    }

    var worker = new Worker(URL.createObjectURL(this._workerBlob));
    worker.onmessage = this._onMessage.bind(this);
    worker.postMessage({
        cmd: 'initialize',
        config: {
            NOTIFICATION: WebMiner.NOTIFICATION,
            domain:       this._domain,
            algorithm:    this._algorithm,
            hash_speed_interval: WebMiner._STATISTIC_INTERVAL
        },
        job: job
    });

    return worker;
}

WebMiner.prototype._stopWorkers = function() {
    while (this._workers.length) {
        this._workers.pop().terminate();
    }
    this.running = false;
    this._notify({ notification: WebMiner.NOTIFICATION.TERMINATED });
}

WebMiner.prototype._onMessage = function(e) {
    if (e.data.notification == WebMiner.NOTIFICATION.SHARE_FOUND) {
        this.shares++;
        this._submitJob(e.data.nonce, e.data.extranonce2);
        //Kill and restart current worker
        if (e.currentTarget instanceof Worker) {
            var i;
            if ((i = this._workers.indexOf(e.currentTarget)) != -1) {
                this._workers.splice(i, 1)[0].terminate();
                var worker = this._createWorker(this._stratumGenWork(this._job));
                worker.postMessage({ 'cmd': 'start' });
                this._workers.push(worker);
            }
        }
    }
    if (e.data.notification == WebMiner.NOTIFICATION.STATISTIC) {
        this._statHashes    += WebMiner._STATISTIC_INTERVAL;
        this.totalHashes    += WebMiner._STATISTIC_INTERVAL;
        this.thisWorkHashes += WebMiner._STATISTIC_INTERVAL;
        var timediff = Date.now() - this._statTime;
        //5 seconds from last measurement
        if (timediff < 1*1000) {
            return;
        } else {
            this.hashRate = this._statHashes * 1000 / timediff;
            this._statHashes = 0;
            this._statTime = Date.now();
        }
    }
    this._notify(e.data);
};

WebMiner.prototype._notify = function(data) {
    var notification = data.notification;
    var message = data.message;

    if (notification != null) {
        switch(notification) {
            case WebMiner.NOTIFICATION.SYSTEM_ERROR:         message = 'System error.'; break;
            case WebMiner.NOTIFICATION.PERMISSION_ERROR:     message = 'Permission error.'; break;
            case WebMiner.NOTIFICATION.CONNECTION_ERROR:     message = 'Connection error, retrying in ' + data.retryPause + ' seconds.'; break;
            case WebMiner.NOTIFICATION.AUTHENTICATION_ERROR: message = 'Invalid worker username or password.'; break;
            case WebMiner.NOTIFICATION.COMMUNICATION_ERROR:  message = 'Communication error.'; break;
            case WebMiner.NOTIFICATION.LONG_POLLING_FAILED:  message = 'Long polling failed.'; break;
            case WebMiner.NOTIFICATION.LONG_POLLING_ENABLED: message = 'Long polling activated.'; break;
            case WebMiner.NOTIFICATION.NEW_BLOCK_DETECTED:   message = 'LONGPOLL detected new block.'; break;
            case WebMiner.NOTIFICATION.NEW_WORK:             message = 'Started new work.'; break;
            case WebMiner.NOTIFICATION.POW_TRUE:             message = 'PROOF OF WORK RESULT: true (yay!!!)'; break;
            case WebMiner.NOTIFICATION.POW_FALSE:            message = 'PROOF OF WORK RESULT: false (booooo)'; break;
            case WebMiner.NOTIFICATION.TERMINATED:           message = 'Terminated.'; break;
            case WebMiner.NOTIFICATION.STARTED:              message = 'Worker started.'; break;
            case WebMiner.NOTIFICATION.SHARE_FOUND:          message = 'New share found. Nonce is ' + data.nonce; break;
            case WebMiner.NOTIFICATION.STATISTIC:
                message = "Hashrate is " + Math.round(this.hashRate) + " h/sec. Total hashes are " + this.totalHashes;
                data.hashRate = this.hashRate;
                break;
        }
    }

    if (message) {
        this._logger(message);
        data.message = message;
    }
    this.onEvent(data);
}


WebMiner.prototype._logger = function() {
    if (this.debug) {
        try {
            console.log.apply(console, Array.prototype.slice.call(arguments, 0));
        } catch(e) {};
    }
};

WebMiner.prototype._newJob = function(data) {
    this._job = {
        job_id:         data.params[0],
        prevhash:       data.params[1],
        coinb1:         data.params[2],
        coinb2:         data.params[3],
        merkle_branch:  data.params[4],
        version:        data.params[5],
        nbits:          data.params[6],
        ntime:          data.params[7]
    };
    this.thisWorkHashes = 0;
    this._notify({ notification: WebMiner.NOTIFICATION.NEW_WORK});

    this._stopWorkers();
    for (var i = 0; i < this.threads; i++) {
        var worker = this._createWorker(this._stratumGenWork(this._job));
        worker.postMessage({ 'cmd': 'start' });
        this._workers.push(worker);
    }
    this.running = true;
    this._notify({ notification: WebMiner.NOTIFICATION.STARTED});
};

WebMiner.prototype._submitJob = function(nonce, extranonce2) {
    this._stratumSend({
        method: "mining.submit", params: [
            this.username,
            this._job.job_id,
            extranonce2,
            this._job.ntime,
            WebMiner._zeropad(nonce.toString(16), 8)
        ]
    }, function(message) {
        if (message.result) {
            this.acceptedShares++;
            this._notify({ notification: WebMiner.NOTIFICATION.POW_TRUE });
        } else {
            this.rejectedShares++;
            this._notify({ notification: WebMiner.NOTIFICATION.POW_FALSE });
        }
    }.bind(this));
}


WebMiner._readScript = function(n) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", n, false);
    xhr.send(null);
    var x = xhr.responseText;
    return x;
};

WebMiner.BLOCK_HEADER_PADDING          = '000000800000000000000000000000000000000000000000000000000000000000000000000000000000000080020000';
WebMiner.REVERSED_BLOCK_HEADER_PADDING = '800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000280';

/* Took from CPU-Miner source code */
WebMiner._calculateTarget = function(diff) {
    diff /= 65536.0;
	for (var k = 6; k > 0 && diff > 1.0; k--)
		diff /= 4294967296.0;
	var m = 4294901760.0 / diff;
    var target = [0, 0, 0, 0, 0, 0, 0, 0];
    target[k] = m & 0xffffffff;
    target[k + 1] = (m / 0xffffffff) | 0;
    return new CryptoJS.lib.WordArray.init(target, 32);
}

WebMiner._zeropad = function(num, length) {
    return (Array(length).join('0') + num).slice(length*-1);
}

WebMiner.prototype._get_extranonce2 = function() {
    return WebMiner._zeropad(this._extranonce2++, this._extranonce2_size*2);
}

WebMiner.prototype._get_block_header_padding = function() {
    return this._coin.reversed_endiannes ? WebMiner.REVERSED_BLOCK_HEADER_PADDING
        : WebMiner.BLOCK_HEADER_PADDING;
}

WebMiner.prototype._stratumGenWork = function(job) {
    job.extranonce2 = this._get_extranonce2();
    job.target      = this._target;

    var coin_base = job.coinb1 + this._extranonce1 + job.extranonce2 + job.coinb2;

    /* Building merkle root */
    var merkle_root = CryptoJS.SHA256(CryptoJS.SHA256(CryptoJS.enc.Hex.parse(coin_base)));
    for (var i in job.merkle_branch) {
        var final_merkle_root = merkle_root.concat(CryptoJS.enc.Hex.parse(job.merkle_branch[i]));
        merkle_root = CryptoJS.SHA256(CryptoJS.SHA256(final_merkle_root));
    }
    job.merkle_root = merkle_root.swap_bytes().toString(CryptoJS.enc.Hex);

    /* Build header */
    job.data = CryptoJS.enc.Hex.parse([job.version, job.prevhash, job.merkle_root, job.ntime, job.nbits, '00000000', this._get_block_header_padding()].join(""));
    if (!this._coin.reversed_endiannes) {
        job.data.swap_bytes();
    }

    return job;
}

/*
CryptoJS v3.1.2
code.google.com/p/crypto-js
(c) 2009-2013 by Jeff Mott. All rights reserved.
code.google.com/p/crypto-js/wiki/License
*/
var CryptoJS=CryptoJS||function(h,s){var f={},t=f.lib={},g=function(){},j=t.Base={extend:function(a){g.prototype=this;var c=new g;a&&c.mixIn(a);c.hasOwnProperty("init")||(c.init=function(){c.$super.init.apply(this,arguments)});c.init.prototype=c;c.$super=this;return c},create:function(){var a=this.extend();a.init.apply(a,arguments);return a},init:function(){},mixIn:function(a){for(var c in a)a.hasOwnProperty(c)&&(this[c]=a[c]);a.hasOwnProperty("toString")&&(this.toString=a.toString)},clone:function(){return this.init.prototype.extend(this)}},
q=t.WordArray=j.extend({init:function(a,c){a=this.words=a||[];this.sigBytes=c!=s?c:4*a.length},toString:function(a){return(a||u).stringify(this)},concat:function(a){var c=this.words,d=a.words,b=this.sigBytes;a=a.sigBytes;this.clamp();if(b%4)for(var e=0;e<a;e++)c[b+e>>>2]|=(d[e>>>2]>>>24-8*(e%4)&255)<<24-8*((b+e)%4);else if(65535<d.length)for(e=0;e<a;e+=4)c[b+e>>>2]=d[e>>>2];else c.push.apply(c,d);this.sigBytes+=a;return this},clamp:function(){var a=this.words,c=this.sigBytes;a[c>>>2]&=4294967295<<
32-8*(c%4);a.length=h.ceil(c/4)},clone:function(){var a=j.clone.call(this);a.words=this.words.slice(0);return a},random:function(a){for(var c=[],d=0;d<a;d+=4)c.push(4294967296*h.random()|0);return new q.init(c,a)}}),v=f.enc={},u=v.Hex={stringify:function(a){var c=a.words;a=a.sigBytes;for(var d=[],b=0;b<a;b++){var e=c[b>>>2]>>>24-8*(b%4)&255;d.push((e>>>4).toString(16));d.push((e&15).toString(16))}return d.join("")},parse:function(a){for(var c=a.length,d=[],b=0;b<c;b+=2)d[b>>>3]|=parseInt(a.substr(b,
2),16)<<24-4*(b%8);return new q.init(d,c/2)}},k=v.Latin1={stringify:function(a){var c=a.words;a=a.sigBytes;for(var d=[],b=0;b<a;b++)d.push(String.fromCharCode(c[b>>>2]>>>24-8*(b%4)&255));return d.join("")},parse:function(a){for(var c=a.length,d=[],b=0;b<c;b++)d[b>>>2]|=(a.charCodeAt(b)&255)<<24-8*(b%4);return new q.init(d,c)}},l=v.Utf8={stringify:function(a){try{return decodeURIComponent(escape(k.stringify(a)))}catch(c){throw Error("Malformed UTF-8 data");}},parse:function(a){return k.parse(unescape(encodeURIComponent(a)))}},
x=t.BufferedBlockAlgorithm=j.extend({reset:function(){this._data=new q.init;this._nDataBytes=0},_append:function(a){"string"==typeof a&&(a=l.parse(a));this._data.concat(a);this._nDataBytes+=a.sigBytes},_process:function(a){var c=this._data,d=c.words,b=c.sigBytes,e=this.blockSize,f=b/(4*e),f=a?h.ceil(f):h.max((f|0)-this._minBufferSize,0);a=f*e;b=h.min(4*a,b);if(a){for(var m=0;m<a;m+=e)this._doProcessBlock(d,m);m=d.splice(0,a);c.sigBytes-=b}return new q.init(m,b)},clone:function(){var a=j.clone.call(this);
a._data=this._data.clone();return a},_minBufferSize:0});t.Hasher=x.extend({cfg:j.extend(),init:function(a){this.cfg=this.cfg.extend(a);this.reset()},reset:function(){x.reset.call(this);this._doReset()},update:function(a){this._append(a);this._process();return this},finalize:function(a){a&&this._append(a);return this._doFinalize()},blockSize:16,_createHelper:function(a){return function(c,d){return(new a.init(d)).finalize(c)}},_createHmacHelper:function(a){return function(c,d){return(new w.HMAC.init(a,
d)).finalize(c)}}});var w=f.algo={};return f}(Math);
(function(h){for(var s=CryptoJS,f=s.lib,t=f.WordArray,g=f.Hasher,f=s.algo,j=[],q=[],v=function(a){return 4294967296*(a-(a|0))|0},u=2,k=0;64>k;){var l;a:{l=u;for(var x=h.sqrt(l),w=2;w<=x;w++)if(!(l%w)){l=!1;break a}l=!0}l&&(8>k&&(j[k]=v(h.pow(u,0.5))),q[k]=v(h.pow(u,1/3)),k++);u++}var a=[],f=f.SHA256=g.extend({_doReset:function(){this._hash=new t.init(j.slice(0))},_doProcessBlock:function(c,d){for(var b=this._hash.words,e=b[0],f=b[1],m=b[2],h=b[3],p=b[4],j=b[5],k=b[6],l=b[7],n=0;64>n;n++){if(16>n)a[n]=
c[d+n]|0;else{var r=a[n-15],g=a[n-2];a[n]=((r<<25|r>>>7)^(r<<14|r>>>18)^r>>>3)+a[n-7]+((g<<15|g>>>17)^(g<<13|g>>>19)^g>>>10)+a[n-16]}r=l+((p<<26|p>>>6)^(p<<21|p>>>11)^(p<<7|p>>>25))+(p&j^~p&k)+q[n]+a[n];g=((e<<30|e>>>2)^(e<<19|e>>>13)^(e<<10|e>>>22))+(e&f^e&m^f&m);l=k;k=j;j=p;p=h+r|0;h=m;m=f;f=e;e=r+g|0}b[0]=b[0]+e|0;b[1]=b[1]+f|0;b[2]=b[2]+m|0;b[3]=b[3]+h|0;b[4]=b[4]+p|0;b[5]=b[5]+j|0;b[6]=b[6]+k|0;b[7]=b[7]+l|0},_doFinalize:function(){var a=this._data,d=a.words,b=8*this._nDataBytes,e=8*a.sigBytes;
d[e>>>5]|=128<<24-e%32;d[(e+64>>>9<<4)+14]=h.floor(b/4294967296);d[(e+64>>>9<<4)+15]=b;a.sigBytes=4*d.length;this._process();return this._hash},clone:function(){var a=g.clone.call(this);a._hash=this._hash.clone();return a}});s.SHA256=g._createHelper(f);s.HmacSHA256=g._createHmacHelper(f)})(Math);

CryptoJS.lib.WordArray.__proto__.swap_bytes = function() {
    for (var i = 0; i < this.words.length; i++) {
        var dword = this.words[i];
        this.words[i] = ((dword>>24)&0xff) | // move byte 3 to byte 0
                    ((dword<<8)&0xff0000)  | // move byte 1 to byte 2
                    ((dword>>8)&0xff00)    | // move byte 2 to byte 1
                    ((dword<<24)&0xff000000);
    }
    return this;
}
