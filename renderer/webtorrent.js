// To keep the UI snappy, we run WebTorrent in its own hidden window, a separate
// process from the main window.
console.time('init')

var WebTorrent = require('webtorrent')
var defaultAnnounceList = require('create-torrent').announceList
var deepEqual = require('deep-equal')
var electron = require('electron')
var fs = require('fs')
var mkdirp = require('mkdirp')
var musicmetadata = require('musicmetadata')
var networkAddress = require('network-address')
var path = require('path')

var crashReporter = require('../crash-reporter')
var config = require('../config')
var torrentPoster = require('./lib/torrent-poster')

// Report when the process crashes
crashReporter.init()

// Send & receive messages from the main window
var ipc = electron.ipcRenderer

// Force use of webtorrent trackers on all torrents
global.WEBTORRENT_ANNOUNCE = defaultAnnounceList
  .map((arr) => arr[0])
  .filter((url) => url.indexOf('wss://') === 0 || url.indexOf('ws://') === 0)

// Connect to the WebTorrent and BitTorrent networks. WebTorrent Desktop is a hybrid
// client, as explained here: https://webtorrent.io/faq
var client = window.client = new WebTorrent()

// WebTorrent-to-HTTP streaming sever
var server = window.server = null

// Used for diffing, so we only send progress updates when necessary
var prevProgress = window.prevProgress = null

init()

function init () {
  client.on('warning', (err) => ipc.send('wt-warning', null, err.message))
  client.on('error', (err) => ipc.send('wt-error', null, err.message))

  ipc.on('wt-start-torrenting', (e, torrentKey, torrentID, path, fileModtimes) =>
    startTorrenting(torrentKey, torrentID, path, fileModtimes))
  ipc.on('wt-stop-torrenting', (e, infoHash) =>
    stopTorrenting(infoHash))
  ipc.on('wt-create-torrent', (e, torrentKey, options) =>
    createTorrent(torrentKey, options))
  ipc.on('wt-save-torrent-file', (e, torrentKey) =>
    saveTorrentFile(torrentKey))
  ipc.on('wt-generate-torrent-poster', (e, torrentKey) =>
    generateTorrentPoster(torrentKey))
  ipc.on('wt-get-audio-metadata', (e, infoHash, index) =>
    getAudioMetadata(infoHash, index))
  ipc.on('wt-start-server', (e, infoHash, index) =>
    startServer(infoHash, index))
  ipc.on('wt-stop-server', (e) =>
    stopServer())

  ipc.send('ipcReadyWebTorrent')

  setInterval(updateTorrentProgress, 1000)
}

// Starts a given TorrentID, which can be an infohash, magnet URI, etc. Returns WebTorrent object
// See https://github.com/feross/webtorrent/blob/master/docs/api.md#clientaddtorrentid-opts-function-ontorrent-torrent-
function startTorrenting (torrentKey, torrentID, path, fileModtimes) {
  console.log('starting torrent %s: %s', torrentKey, torrentID)
  var torrent = client.add(torrentID, {
    path: path,
    fileModtimes: fileModtimes
  })
  torrent.key = torrentKey
  addTorrentEvents(torrent)
  return torrent
}

function stopTorrenting (infoHash) {
  var torrent = client.get(infoHash)
  torrent.destroy()
}

// Create a new torrent, start seeding
function createTorrent (torrentKey, options) {
  console.log('creating torrent %s', torrentKey, options)
  var torrent = client.seed(options.files, options)
  torrent.key = torrentKey
  addTorrentEvents(torrent)
  ipc.send('wt-new-torrent')
}

function addTorrentEvents (torrent) {
  torrent.on('warning', (err) =>
    ipc.send('wt-warning', torrent.key, err.message))
  torrent.on('error', (err) =>
    ipc.send('wt-error', torrent.key, err.message))
  torrent.on('infoHash', () =>
    ipc.send('wt-infohash', torrent.key, torrent.infoHash))
  torrent.on('metadata', torrentMetadata)
  torrent.on('ready', torrentReady)
  torrent.on('done', torrentDone)

  function torrentMetadata () {
    var info = getTorrentInfo(torrent)
    ipc.send('wt-metadata', torrent.key, info)

    updateTorrentProgress()
  }

  function torrentReady () {
    var info = getTorrentInfo(torrent)
    ipc.send('wt-ready', torrent.key, info)
    ipc.send('wt-ready-' + torrent.infoHash, torrent.key, info) // TODO: hack

    updateTorrentProgress()
  }

  function torrentDone () {
    var info = getTorrentInfo(torrent)
    ipc.send('wt-done', torrent.key, info)

    updateTorrentProgress()

    torrent.getFileModtimes(function (err, fileModtimes) {
      if (err) return onError(err)
      ipc.send('wt-file-modtimes', torrent.key, fileModtimes)
    })
  }
}

// Produces a JSON saveable summary of a torrent
function getTorrentInfo (torrent) {
  return {
    infoHash: torrent.infoHash,
    magnetURI: torrent.magnetURI,
    name: torrent.name,
    path: torrent.path,
    files: torrent.files.map(getTorrentFileInfo),
    bytesReceived: torrent.received
  }
}

// Produces a JSON saveable summary of a file in a torrent
function getTorrentFileInfo (file) {
  return {
    name: file.name,
    length: file.length,
    path: file.path,
    numPiecesPresent: 0,
    numPieces: null
  }
}

// Every time we resolve a magnet URI, save the torrent file so that we never
// have to download it again. Never ask the DHT the same question twice.
function saveTorrentFile (torrentKey) {
  var torrent = getTorrent(torrentKey)
  checkIfTorrentFileExists(torrent.infoHash, function (torrentPath, exists) {
    if (exists) {
      // We've already saved the file
      return ipc.send('wt-file-saved', torrentKey, torrentPath)
    }

    // Otherwise, save the .torrent file, under the app config folder
    fs.mkdir(config.CONFIG_TORRENT_PATH, function (_) {
      fs.writeFile(torrentPath, torrent.torrentFile, function (err) {
        if (err) return console.log('error saving torrent file %s: %o', torrentPath, err)
        console.log('saved torrent file %s', torrentPath)
        return ipc.send('wt-file-saved', torrentKey, torrentPath)
      })
    })
  })
}

// Checks whether we've already resolved a given infohash to a torrent file
// Calls back with (torrentPath, exists). Logs, does not call back on error
function checkIfTorrentFileExists (infoHash, cb) {
  var torrentPath = path.join(config.CONFIG_TORRENT_PATH, infoHash + '.torrent')
  fs.exists(torrentPath, function (exists) {
    cb(torrentPath, exists)
  })
}

// Save a JPG that represents a torrent.
// Auto chooses either a frame from a video file, an image, etc
function generateTorrentPoster (torrentKey) {
  var torrent = getTorrent(torrentKey)
  torrentPoster(torrent, function (err, buf, extension) {
    if (err) return console.log('error generating poster: %o', err)
    // save it for next time
    mkdirp(config.CONFIG_POSTER_PATH, function (err) {
      if (err) return console.log('error creating poster dir: %o', err)
      var posterFilePath = path.join(config.CONFIG_POSTER_PATH, torrent.infoHash + extension)
      fs.writeFile(posterFilePath, buf, function (err) {
        if (err) return console.log('error saving poster: %o', err)
        // show the poster
        ipc.send('wt-poster', torrentKey, posterFilePath)
      })
    })
  })
}

function updateTorrentProgress () {
  var progress = getTorrentProgress()
  // TODO: diff torrent-by-torrent, not once for the whole update
  if (prevProgress && deepEqual(progress, prevProgress, {strict: true})) {
    return /* don't send heavy object if it hasn't changed */
  }
  ipc.send('wt-progress', progress)
  prevProgress = progress
}

function getTorrentProgress () {
  // First, track overall progress
  var progress = client.progress
  var hasActiveTorrents = client.torrents.some(function (torrent) {
    return torrent.progress !== 1
  })

  // Track progress for every file in each torrent
  // TODO: ideally this would be tracked by WebTorrent, which could do it
  // more efficiently than looping over torrent.bitfield
  var torrentProg = client.torrents.map(function (torrent) {
    var fileProg = torrent.files && torrent.files.map(function (file, index) {
      var numPieces = file._endPiece - file._startPiece + 1
      var numPiecesPresent = 0
      for (var piece = file._startPiece; piece <= file._endPiece; piece++) {
        if (torrent.bitfield.get(piece)) numPiecesPresent++
      }
      return {
        startPiece: file._startPiece,
        endPiece: file._endPiece,
        numPieces,
        numPiecesPresent
      }
    })
    return {
      torrentKey: torrent.key,
      ready: torrent.ready,
      progress: torrent.progress,
      downloaded: torrent.downloaded,
      downloadSpeed: torrent.downloadSpeed,
      uploadSpeed: torrent.uploadSpeed,
      numPeers: torrent.numPeers,
      length: torrent.length,
      bitfield: torrent.bitfield,
      files: fileProg
    }
  })

  return {
    torrents: torrentProg,
    progress,
    hasActiveTorrents
  }
}

function startServer (infoHash, index) {
  var torrent = client.get(infoHash)
  if (torrent.ready) startServerFromReadyTorrent(torrent, index)
  else torrent.on('ready', () => startServerFromReadyTorrent(torrent, index))
}

function startServerFromReadyTorrent (torrent, index, cb) {
  if (server) return

  // start the streaming torrent-to-http server
  server = torrent.createServer()
  server.listen(0, function () {
    var port = server.address().port
    var urlSuffix = ':' + port + '/' + index
    var info = {
      torrentKey: torrent.key,
      localURL: 'http://localhost' + urlSuffix,
      networkURL: 'http://' + networkAddress() + urlSuffix
    }

    ipc.send('wt-server-running', info)
    ipc.send('wt-server-' + torrent.infoHash, info) // TODO: hack
  })
}

function stopServer () {
  if (!server) return
  server.destroy()
  server = null
}

function getAudioMetadata (infoHash, index) {
  var torrent = client.get(infoHash)
  var file = torrent.files[index]
  musicmetadata(file.createReadStream(), function (err, info) {
    if (err) return
    console.log('got audio metadata for %s: %o', file.name, info)
    ipc.send('wt-audio-metadata', infoHash, index, info)
  })
}

// Gets a WebTorrent handle by torrentKey
// Throws an Error if we're not currently torrenting anything w/ that key
function getTorrent (torrentKey) {
  var ret = client.torrents.find((x) => x.key === torrentKey)
  if (!ret) throw new Error('missing torrent key ' + torrentKey)
  return ret
}

function onError (err) {
  console.log(err)
}
