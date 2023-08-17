// We import the settings.js file to know which address we should contact
// to talk to Janus, and optionally which STUN/TURN servers should be
// used as well. Specifically, that file defines the "server" and
// "iceServers" properties we'll pass when creating the Janus session.

/* global iceServers:readonly, Janus:readonly, server:readonly */

var janus = null;
var videoRoomPlugIn = null;
var opaqueId = "videoroomtest-"+Janus.randomString(12);

var callbackUpdateUI = null;

var myroom = 1234;	// Demo room
if(getQueryStringValue("room") !== "")
	myroom = parseInt(getQueryStringValue("room"));
var myusername = null;
var myid = null;
var mystream = null;
// We use this other ID just to map our subscriptions to us
var mypvtid = null;

var localTracks = {}, localVideos = 0;
var feeds = [], feedStreams = {};
var bitrateTimer = [];

var doSimulcast = (getQueryStringValue("simulcast") === "yes" || getQueryStringValue("simulcast") === "true");
var doSvc = getQueryStringValue("svc");
if(doSvc === "")
	doSvc = null;
var acodec = (getQueryStringValue("acodec") !== "" ? getQueryStringValue("acodec") : null);
var vcodec = (getQueryStringValue("vcodec") !== "" ? getQueryStringValue("vcodec") : null);
var doDtx = (getQueryStringValue("dtx") === "yes" || getQueryStringValue("dtx") === "true");
var subscriber_mode = (getQueryStringValue("subscriber-mode") === "yes" || getQueryStringValue("subscriber-mode") === "true");
var use_msid = (getQueryStringValue("msid") === "yes" || getQueryStringValue("msid") === "true");


function replaceVideoTrack(track) {
    const videoTransceiver = videoRoomPlugIn.webrtcStuff.pc.getTransceivers()
    .find(t => (t.receiver.track.kind === 'video'));
    try {
        videoTransceiver.sender.replaceTrack(track);
    } catch (error) {
        console.warn('Not able to replace track, error:', error);
    }
}

function onRegistrationComplete(msg) {
    // Publisher/manager created, negotiate WebRTC and attach to existing feeds, if any
    myid = msg["id"];
    mypvtid = msg["private_id"];
    Janus.log("Successfully joined room " + msg["room"] + " with ID " + myid);

    callbackUpdateUI({action:'registered'});

    // Any new feed to attach to?
    if(msg["publishers"]) {
        let list = msg["publishers"];
        Janus.debug("Got a list of available publishers/feeds:", list);
        for(let f in list) {
            if(list[f]["dummy"])
                continue;
            let id = list[f]["id"];
            let streams = list[f]["streams"];
            let display = list[f]["display"];
            for(let i in streams) {
                let stream = streams[i];
                stream["id"] = id;
                stream["display"] = display;
            }
            feedStreams[id] = streams;
            Janus.debug("  >> [" + id + "] " + display + ":", streams);
            newRemoteFeed(id, display, streams);
        }
    }
}

function attachVideoRoomPlugIn(username) {
    // Attach to VideoRoom plugin
    janus.attach(
        {
            plugin: "janus.plugin.videoroom",
            opaqueId: opaqueId,
            success: function(pluginHandle) {
                videoRoomPlugIn = pluginHandle;
                Janus.log("VideoRoomPlugin attached! (" + videoRoomPlugIn.getPlugin() + ", id=" + videoRoomPlugIn.getId() + ")");
                registerUsername(username)
            },
            error: function(error) {
                Janus.error("  -- Error attaching plugin...", error);
            },

            iceState: function(state) {
                Janus.log("ICE state changed to " + state);
            },
            mediaState: function(medium, on, mid) {
                Janus.log("Janus " + (on ? "started" : "stopped") + " receiving our " + medium + " (mid=" + mid + ")");
            },
            webrtcState: function(on) {
                Janus.log("Janus says our WebRTC PeerConnection is " + (on ? "up" : "down") + " now");
             },
            slowLink: function(uplink, lost, mid) {
                Janus.warn("Janus reports problems " + (uplink ? "sending" : "receiving") +
                    " packets on mid " + mid + " (" + lost + " lost packets)");
            },
            onmessage: function(msg, jsep) {
                Janus.debug(" ::: Got a message (publisher) :::", msg);
                let event = msg["videoroom"];
                Janus.debug("Event: " + event);
                if(event) {
                    if(event === "joined") {
                        // Once the registration is complete, you can publish your own stream.
                        onRegistrationComplete(msg);
                    } else if(event === "destroyed") {
                        // The room has been destroyed
                        Janus.warn("The room has been destroyed!");
                    } else if(event === "event") {
                        // Any info on our streams or a new feed to attach to?
                        if(msg["streams"]) {
                            let streams = msg["streams"];
                            for(let i in streams) {
                                let stream = streams[i];
                                stream["id"] = myid;
                                stream["display"] = myusername;
                            }
                            feedStreams[myid] = streams;
                        } else if(msg["publishers"]) {
                            let list = msg["publishers"];
                            Janus.debug("Got a list of available publishers/feeds:", list);
                            for(let f in list) {
                                if(list[f]["dummy"])
                                    continue;
                                let id = list[f]["id"];
                                let display = list[f]["display"];
                                let streams = list[f]["streams"];
                                for(let i in streams) {
                                    let stream = streams[i];
                                    stream["id"] = id;
                                    stream["display"] = display;
                                }
                                feedStreams[id] = streams;
                                Janus.debug("  >> [" + id + "] " + display + ":", streams);
                                newRemoteFeed(id, display, streams);
                            }
                        } else if(msg["leaving"]) {
                            // One of the publishers has gone away?
                            let leaving = msg["leaving"];
                            Janus.log("Publisher left: " + leaving);
                            let remoteFeed = null;
                            for(let i=1; i<6; i++) {
                                if(feeds[i] && feeds[i].rfid == leaving) {
                                    remoteFeed = feeds[i];
                                    break;
                                }
                            }
                            if(remoteFeed) {
                                Janus.debug("Feed " + remoteFeed.rfid + " (" + remoteFeed.rfdisplay + ") has left the room, detaching");
                                 // handle UI as per the remote publisher has left. So all streams from this user needs to be removed.
                                 callbackUpdateUI({action: "removeremote", mediatype: "video", rfid: remoteFeed.rfindex});
                                feeds[remoteFeed.rfindex] = null;
                                remoteFeed.detach();
                            }
                            delete feedStreams[leaving];
                        } else if(msg["unpublished"]) {
                            // One of the publishers has unpublished?
                            let unpublished = msg["unpublished"];
                            Janus.log("Publisher left: " + unpublished);
                            if(unpublished === 'ok') {
                                // That's us
                                videoRoomPlugIn.hangup();
                                return;
                            }
                            let remoteFeed = null;
                            for(let i=1; i<6; i++) {
                                if(feeds[i] && feeds[i].rfid == unpublished) {
                                    remoteFeed = feeds[i];
                                    break;
                                }
                            }
                            if(remoteFeed) {
                                Janus.debug("Feed " + remoteFeed.rfid + " (" + remoteFeed.rfdisplay + ") has left the room, detaching");

                                 // handle UI as per the remote publisher has left. So all streams from this user needs to be removed.
                                 callbackUpdateUI({action: "removeremote", mediatype: "video", rfid: remoteFeed.rfindex});
                                feeds[remoteFeed.rfindex] = null;
                                remoteFeed.detach();
                            }
                            delete feedStreams[unpublished];
                        } else if(msg["error"]) {
                            if(msg["error_code"] === 426) {
                                console.error("No such room found" + myroom);
                            } else {
                                console.error("Some error in joining room:" + myroom);
                            }
                        }
                    }
                }
                if(jsep) {
                    Janus.debug("Handling SDP as well...", jsep);
                    videoRoomPlugIn.handleRemoteJsep({ jsep: jsep });
                    // Check if any of the media we wanted to publish has
                    // been rejected (e.g., wrong or unsupported codec)
                    let audio = msg["audio_codec"];
                    if(mystream && mystream.getAudioTracks() && mystream.getAudioTracks().length > 0 && !audio) {
                        // Audio has been rejected
                        console.warning("Our audio stream has been rejected, viewers won't hear us");
                    }
                    let video = msg["video_codec"];
                    if(mystream && mystream.getVideoTracks() && mystream.getVideoTracks().length > 0 && !video) {
                        // Video has been rejected
                        console.warning("Our video stream has been rejected, viewers won't see us");
                    }
                }
            },
            onlocaltrack: function(track, on) {
                Janus.debug("Local track " + (on ? "added" : "removed") + ":", track);
                // We use the track ID as name of the element, but it may contain invalid characters
                let trackId = track.id.replace(/[{}]/g, "");
                if(!on) {
                    // Track removed, get rid of the stream and the rendering
                    let stream = localTracks[trackId];
                    if(stream) {
                        try {
                            let tracks = stream.getTracks();
                            for(let i in tracks) {
                                let mst = tracks[i];
                                if(mst !== null && mst !== undefined)
                                    mst.stop();
                            }
                        } catch(e) {}
                    }
                    if(track.kind === "video") {
                        localVideos--;
                        if(localVideos === 0) {

                        }
                    }
                    delete localTracks[trackId];
                    return;
                }
                // If we're here, a new track was added
                let stream = localTracks[trackId];
                if(stream) {
                    // We've been here already
                    return;
                }
                if(track.kind === "audio") {
                    // We ignore local audio tracks, they'd generate echo anyway
                    if(localVideos === 0) {

                    }
                } else {
                    // New video track: create a stream out of it
                    localVideos++;
                    stream = new MediaStream([track]);
                    localTracks[trackId] = stream;
                    Janus.log("Created local stream:", stream);
                    Janus.log(stream.getTracks());
                    Janus.log(stream.getVideoTracks());

                    // handle UI as per the remoteStream operations such as remote feed is removed or changed etc.
                    callbackUpdateUI({action: "addlocalvideo", mediatype: "video", stream: stream});
                }
                if(videoRoomPlugIn.webrtcStuff.pc.iceConnectionState !== "completed" &&
                        videoRoomPlugIn.webrtcStuff.pc.iceConnectionState !== "connected") {
                    console.debug("connection status:" + videoRoomPlugIn.webrtcStuff.pc.iceConnectionState);            
                }
            },
            // eslint-disable-next-line no-unused-vars
            onremotetrack: function(track, mid, on) {
                // The publisher stream is sendonly, we don't expect anything here
            },
            oncleanup: function() {
                Janus.log(" ::: Got a cleanup notification: we are unpublished now :::");
                // handle UI as per the remoteStream operations such as remote feed is removed or changed etc.
                callbackUpdateUI({action: "removelocalvideo", mediatype: "video"});
                mystream = null;
                delete feedStreams[myid];
                localTracks = {};
                localVideos = 0;
            }
        });
}


function initializeJanus(janusUrl, roomName, username, cbUpdateUI) {
    console.log("in initializeJanus function");
    myroom = roomName;
    callbackUpdateUI = cbUpdateUI;
    iceServers = null;

	// Initialize the library (all console debuggers enabled)
	Janus.init({debug: "all", callback: function() {
        			// Create session
        janus = new Janus(
            {
                server: janusUrl,
                iceServers: iceServers,
                success: function() {
                    attachVideoRoomPlugIn(username);
                },
                error: function(error) {
                    Janus.error(error);
                },
                destroyed: function() {
                    window.location.reload();
                }
            });

	}});
}


function registerUsername(username) {
    let register = {
        request: "join",
        room: myroom,
        ptype: "publisher",
        display: username
    };
    myusername = escapeXmlTags(username);
    videoRoomPlugIn.send({ message: register });
}


function publishOwnFeed(useAudio, videoTrack) {
	// We want sendonly audio and video (uncomment the data track
	// too if you want to publish via datachannels as well)
	let tracks = [];
	if(useAudio)
		tracks.push({ type: 'audio', capture: true, recv: false });

	tracks.push({ type: 'video', capture: videoTrack ? videoTrack : true, recv: false,
		// We may need to enable simulcast or SVC on the video track
		simulcast: doSimulcast,
		// We only support SVC for VP9 and (still WIP) AV1
		svc: ((vcodec === 'vp9' || vcodec === 'av1') && doSvc) ? doSvc : null
	});

    console.log("in publishOwnFeed -- videotracks = ", videoTrack, tracks);

	videoRoomPlugIn.createOffer(
		{
			tracks: tracks,
			customizeSdp: function(jsep) {
				// If DTX is enabled, munge the SDP
				if(doDtx) {
					jsep.sdp = jsep.sdp
						.replace("useinbandfec=1", "useinbandfec=1;usedtx=1")
				}
			},
			success: function(jsep) {
				Janus.debug("Got publisher SDP!", jsep);
				let publish = { request: "configure", audio: useAudio, video: true };
				// You can force a specific codec to use when publishing by using the
				// audiocodec and videocodec properties, for instance:
				// 		publish["audiocodec"] = "opus"
				// to force Opus as the audio codec to use, or:
				// 		publish["videocodec"] = "vp9"
				// to force VP9 as the videocodec to use. In both case, though, forcing
				// a codec will only work if: (1) the codec is actually in the SDP (and
				// so the browser supports it), and (2) the codec is in the list of
				// allowed codecs in a room. With respect to the point (2) above,
				// refer to the text in janus.plugin.videoroom.jcfg for more details.
				// We allow people to specify a codec via query string, for demo purposes
				if(acodec)
					publish["audiocodec"] = acodec;
				if(vcodec)
					publish["videocodec"] = vcodec;
				videoRoomPlugIn.send({ message: publish, jsep: jsep });
			},
			error: function(error) {
				Janus.error("WebRTC error:", error);
				if(useAudio) {
					publishOwnFeed(false);
				} else {
					console.error("WebRTC error... " + error.message);
				}
			}
		});
}

function toggleMute() {
	let muted = videoRoomPlugIn.isAudioMuted();
	Janus.log((muted ? "Unmuting" : "Muting") + " local stream...");
	if(muted)
		videoRoomPlugIn.unmuteAudio();
	else
		videoRoomPlugIn.muteAudio();
	muted = videoRoomPlugIn.isAudioMuted();
}

function unpublishOwnFeed() {
	let unpublish = { request: "unpublish" };
	videoRoomPlugIn.send({ message: unpublish });
}

function newRemoteFeed(id, display, streams) {
	// A new feed has been published, create a new plugin handle and attach to it as a subscriber
	let remoteFeed = null;
	if(!streams)
		streams = feedStreams[id];
	janus.attach(
		{
			plugin: "janus.plugin.videoroom",
			opaqueId: opaqueId,
			success: function(pluginHandle) {
				remoteFeed = pluginHandle;
				remoteFeed.remoteTracks = {};
				remoteFeed.remoteVideos = 0;
				remoteFeed.simulcastStarted = false;
				remoteFeed.svcStarted = false;
				Janus.log("Plugin attached! (" + remoteFeed.getPlugin() + ", id=" + remoteFeed.getId() + ")");
				Janus.log("  -- This is a subscriber");
				// Prepare the streams to subscribe to, as an array: we have the list of
				// streams the feed is publishing, so we can choose what to pick or skip
				let subscription = [];
				for(let i in streams) {
					let stream = streams[i];
					// If the publisher is VP8/VP9 and this is an older Safari, let's avoid video
					if(stream.type === "video" && Janus.webRTCAdapter.browserDetails.browser === "safari" &&
							((stream.codec === "vp9" && !Janus.safariVp9) || (stream.codec === "vp8" && !Janus.safariVp8))) {
						console.warning("Publisher is using " + stream.codec.toUpperCase +
							", but Safari doesn't support it: disabling video stream #" + stream.mindex);
						continue;
					}
					subscription.push({
						feed: stream.id,	// This is mandatory
						mid: stream.mid		// This is optional (all streams, if missing)
					});
					// FIXME Right now, this is always the same feed: in the future, it won't
					remoteFeed.rfid = stream.id;
					remoteFeed.rfdisplay = escapeXmlTags(stream.display);
				}
				// We wait for the plugin to send us an offer
				let subscribe = {
					request: "join",
					room: myroom,
					ptype: "subscriber",
					streams: subscription,
					use_msid: use_msid,
					private_id: mypvtid
				};
				remoteFeed.send({ message: subscribe });
			},
			error: function(error) {
				Janus.error("  -- Error attaching plugin...", error);
			},
			iceState: function(state) {
				Janus.log("ICE state (feed #" + remoteFeed.rfindex + ") changed to " + state);
			},
			webrtcState: function(on) {
				Janus.log("Janus says this WebRTC PeerConnection (feed #" + remoteFeed.rfindex + ") is " + (on ? "up" : "down") + " now");
			},
			slowLink: function(uplink, lost, mid) {
				Janus.warn("Janus reports problems " + (uplink ? "sending" : "receiving") +
					" packets on mid " + mid + " (" + lost + " lost packets)");
			},
			onmessage: function(msg, jsep) {
				Janus.debug(" ::: Got a message (subscriber) :::", msg);
				let event = msg["videoroom"];
				Janus.debug("Event: " + event);
				if(msg["error"]) {
					console.error(msg["error"]);
				} else if(event) {
					if(event === "attached") {
						// Subscriber created and attached
						for(let i=1;i<6;i++) {
							if(!feeds[i]) {
								feeds[i] = remoteFeed;
								remoteFeed.rfindex = i;
								break;
							}
						}

						Janus.log("Successfully attached to feed in room " + msg["room"]);
					} else if(event === "event") {
						// Check if we got a simulcast-related event from this publisher
						let substream = msg["substream"];
						let temporal = msg["temporal"];
						if((substream !== null && substream !== undefined) || (temporal !== null && temporal !== undefined)) {
							if(!remoteFeed.simulcastStarted) {
								remoteFeed.simulcastStarted = true;
							}
						}
						let spatial = msg["spatial_layer"];
						temporal = msg["temporal_layer"];
						if((spatial !== null && spatial !== undefined) || (temporal !== null && temporal !== undefined)) {
							if(!remoteFeed.svcStarted) {
								remoteFeed.svcStarted = true;
							}
						}
					} else {
						// What has just happened?
					}
				}
				if(jsep) {
					Janus.debug("Handling SDP as well...", jsep);
					let stereo = (jsep.sdp.indexOf("stereo=1") !== -1);
					// Answer and attach
					remoteFeed.createAnswer(
						{
							jsep: jsep,
							// We only specify data channels here, as this way in
							// case they were offered we'll enable them. Since we
							// don't mention audio or video tracks, we autoaccept them
							// as recvonly (since we won't capture anything ourselves)
							tracks: [
								{ type: 'data' }
							],
							customizeSdp: function(jsep) {
								if(stereo && jsep.sdp.indexOf("stereo=1") == -1) {
									// Make sure that our offer contains stereo too
									jsep.sdp = jsep.sdp.replace("useinbandfec=1", "useinbandfec=1;stereo=1");
								}
							},
							success: function(jsep) {
								Janus.debug("Got SDP!", jsep);
								let body = { request: "start", room: myroom };
								remoteFeed.send({ message: body, jsep: jsep });
							},
							error: function(error) {
								Janus.error("WebRTC error:", error);
							}
						});
				}
			},
			// eslint-disable-next-line no-unused-vars
			onlocaltrack: function(track, on) {
				// The subscriber stream is recvonly, we don't expect anything here
			},
			onremotetrack: function(track, mid, on, metadata) {
				Janus.debug(
					"Remote feed #" + remoteFeed.rfindex +
					", remote track (mid=" + mid + ") " +
					(on ? "added" : "removed") +
					(metadata? " (" + metadata.reason + ") ": "") + ":", track
				);
				if(!on) {
					// Track removed, get rid of the stream and the rendering

					if(track.kind === "video") {
						remoteFeed.remoteVideos--;

                        // handle UI as per the remoteStream operations such as remote feed is removed or changed etc.
                        callbackUpdateUI({action: "removeremote", mediatype: "video", rfid: remoteFeed.rfindex, mid: mid});
					}
					delete remoteFeed.remoteTracks[mid];
					return;
				}

				if(track.kind === "audio") {
					// New audio track: create a stream out of it, and use a hidden <audio> element
					let stream = new MediaStream([track]);
					remoteFeed.remoteTracks[mid] = stream;
					Janus.log("Created remote audio stream:", stream);

                    // handle UI as per the remoteStream operations such as remote feed is removed or changed etc.
                    callbackUpdateUI({action: "addremote", mediatype: "audio", rfid: remoteFeed.rfindex, mid: mid, stream: stream});
				} else {
					// New video track: create a stream out of it
					remoteFeed.remoteVideos++;
					let stream = new MediaStream([track]);
					remoteFeed.remoteTracks[mid] = stream;
					Janus.log("Created remote video stream:", stream);

                    // handle UI as per the remoteStream operations such as remote feed is removed or changed etc.
                    callbackUpdateUI({action: "addremote", mediatype: "video", rfid: remoteFeed.rfindex, mid: mid, stream: stream});
				}
			},
			oncleanup: function() {
				Janus.log(" ::: Got a cleanup notification (remote feed " + id + ") :::");

				remoteFeed.simulcastStarted = false;
				remoteFeed.remoteTracks = {};
				remoteFeed.remoteVideos = 0;
			}
		});
}

// Helper to parse query string
function getQueryStringValue(name) {
	name = name.replace(/[\[]/, "\\[").replace(/[\]]/, "\\]");
	let regex = new RegExp("[\\?&]" + name + "=([^&#]*)"),
		results = regex.exec(location.search);
	return results === null ? "" : decodeURIComponent(results[1].replace(/\+/g, " "));
}

// Helper to escape XML tags
function escapeXmlTags(value) {
	if(value) {
		let escapedValue = value.replace(new RegExp('<', 'g'), '&lt');
		escapedValue = escapedValue.replace(new RegExp('>', 'g'), '&gt');
		return escapedValue;
	}
}


