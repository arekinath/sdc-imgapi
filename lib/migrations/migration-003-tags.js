#!/usr/bin/env node
/*
 * IMGAPI UFDS db migration: renames billing_tags field to billingtag
 */

var fs = require('fs');
var path = require('path');
var ldap = require('ldapjs');
var errors = require('../errors');
var assert = require('assert-plus');
var async = require('async');



//---- globals

var NAME = path.basename(__filename);

var CONFIG_PATH = (fs.existsSync('/root/THIS-IS-IMAGES.JOYENT.COM.txt')
    ? '/root/config/imgapi.config.json'
    : '/opt/smartdc/imgapi/etc/imgapi.config.json');
var config = JSON.parse(fs.readFileSync(CONFIG_PATH));
var ufdsClient = null;  // set in `getUfdsClient()`




//---- support functions

function errexit(err) {
    console.error(NAME + ' error: ' + err);
    process.exit(1);
}

function warn() {
    arguments[0] = NAME + ' warn: ' + arguments[0];
    console.warn.apply(null, arguments);
}

function info() {
    arguments[0] = NAME + ' info: ' + arguments[0];
    console.log.apply(null, arguments);
}

function getUfdsClient(callback) {
    var client = ldap.createClient({
        url: config.ufds.url,
        connectTimeout: 2 * 1000
    });
    client.bind(config.ufds.bindDN, config.ufds.bindPassword,
        function (bErr) {
            if (bErr) {
                return callback(bErr);
            }
            return callback(null, client);
        }
    );
}

function ufdsListImages(callback) {
    var base = 'ou=images, o=smartdc';
    var opts = {
        filter: 'objectclass=sdcimage',
        scope: 'one'
    };
    ufdsClient.search(base, opts, function (sErr, result) {
        if (sErr) {
            return callback(sErr);
        }

        var images = [];
        result.on('searchEntry', function (entry) {
            images.push(entry.object);
        });

        result.on('error', function (err) {
            callback(err);
        });

        result.on('end', function (res) {
            if (res.status !== 0) {
                return callback(new errors.InternalError(
                    'non-zero status from LDAP search: ' + res));
            }
            callback(null, images);
        });
    });
}


function objectToTag(obj) {
    if (typeof (obj) === 'string') {
        obj = JSON.parse(obj);
    }

    var values = [];
    Object.keys(obj).forEach(function (key) {
        var value = key + '=' + obj[key];
        values.push(value);
    });

    return values;
}


function migrateImage(image, callback) {
    var id = (config.database.type === 'ufds' ? image.dn
        : image.uuid + '.raw');
    var tags = image.tags;
    if (!tags)
        return callback();
    info('migrate "%s"', id);

    // Rename it to tags and make it an array and not a stringified object
    if (config.database.type === 'ufds') {
        var changes = [{
            operation: 'add',
            modification: { tag: objectToTag(tags) }
        }, {
            operation: 'delete',
            modification: { tags: tags }
        }];
        ufdsClient.modify(image.dn, changes, callback);
    } else {
        // No change needed for local database. image.tags is an object
        return callback();
    }
}

function ufdsMigrate(callback) {
    assert.equal(config.database.type, 'ufds');
    getUfdsClient(function (err, client) {
        if (err)
            return callback(err);
        ufdsClient = client; // intentionally global
        ufdsListImages(function (err2, images) {
            if (err2)
                return callback(err2);
            async.forEachSeries(images, migrateImage, callback);
        });
    });
}

function localListImages(callback) {
    /*JSSTYLED*/
    var RAW_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.raw$/;
    fs.readdir(config.database.dir, function (err, files) {
        var images = [];
        async.forEachSeries(
            files,
            function oneFile(file, next) {
                if (!RAW_FILE_RE.test(file))
                    return next();
                var p = path.resolve(config.database.dir, file);
                fs.readFile(p, 'utf8', function (readErr, content) {
                    if (readErr)
                        return next(readErr);
                    try {
                        images.push(JSON.parse(content));
                    } catch (ex) {
                        return next(ex);
                    }
                    next();
                });
            },
            function done(err2) {
                callback(err2, images);
            }
        );
    });
}


function localMigrate(callback) {
    assert.equal(config.database.type, 'local');
    localListImages(function (err, images) {
        if (err)
            return callback(err);
        async.forEachSeries(images, migrateImage, callback);
    });
}



//---- mainline

function main(argv) {
    assert.object(config.database, 'config.database');
    var migrator = (config.database.type === 'ufds'
        ? ufdsMigrate : localMigrate);
    migrator(function (err) {
        if (err) {
            errexit(err);
        } else {
            process.exit(0);
        }
    });
}

if (require.main === module) {
    main(process.argv);
}