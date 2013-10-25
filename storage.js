var AWS = require('aws-sdk');
var config = require('./config');
var http = require('http');
var log = require('./log');
var semaphore = require('semaphore');

var sem = semaphore(config.maxConcurrentProxyStreams || 2);

AWS.config.loadFromPath('./config/aws.json');
var s3 = new AWS.S3();

exports.getObject = function(key, cb) {
    var params = {
        Bucket: config.awsBucket,
        Key: key
    };
    s3.getObject(params, function(err, res) {
        cb(err, res);
    });
};

exports.upload = function(params, cb) {
    s3.putObject({
        ACL: 'public-read',
        Body: params.data,
        Bucket: config.awsBucket,
        Key: params.key,
        CacheControl: 'max-age=31536000', // 1 year
        ContentType: params.contentType
    }, function(err, res) {
        if (err) {
            cb(err, res);
        } else {
            cb();
        }
    });
};

exports.proxyRequest = function(req, res, key, cb) {
    sem.take(function() {
        var leftSem = false;
        var proxyReq = http.request({
            host: 's3.amazonaws.com',
            method: req.method,
            path: '/' + config.awsBucket + '/' + key,
            headers: req.headers
        });

        proxyReq.on('response', function(proxyRes) {
            var status = proxyRes.statusCode;
            if (status != 200 && status != 304 && cb) {
                cb('Proxy request returned non 200 response.');
            } else {
                proxyRes.on('data', function(chunk) {
                    res.write(chunk, 'binary');
                });
                proxyRes.on('end', function() {
                    res.end();
                    if (cb) {
                        cb();
                    }
                    if (!leftSem) {
                        leftSem = true;
                        sem.leave();
                    }
                });
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
            }
            res.on('close', function() {
                proxyReq.abort();
                if (!leftSem) {
                    leftSem = true;
                    sem.leave();
                }
            });
        });
        proxyReq.end();
    });
};