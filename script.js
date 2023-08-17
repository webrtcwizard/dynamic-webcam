const backGroundCanvas = document.createElement('canvas');
const video = document.createElement('video');
const janusURL = 'wss://janus.conf.meetecho.com/ws';
const ANIMATION_INETRVAL = 100;
const ANIMATION_SPEED = 5;
const DISPLACEMENT_IGNORED = 7;
const PREDICTION_THRESHOLD = 0.5;
const ENABLE_LOG = false;

let faceDetector;
let isUpdating = false;
let animationIntervalId;
let targetBbox;
let localVideoStream = null;
let animationTimer;
let secDrawAnimTimer;

video.autoplay = true;
video.muted = true;
backGroundCanvas.width = 480;
backGroundCanvas.height = 360;


window.onload = () => {
  let joinButton = document.getElementById('joinRoomButton');
  let isDynamic = document.getElementById('isdynamic');

  joinButton.addEventListener('click', () => {
    joinroom();
  })

  isDynamic.addEventListener('click', () => {
    toggleDynamicWebcam();
  })
}

function toggleDynamicWebcam() {
  // listen to change of isDynamic button state
  let isDynamic = document.getElementById('isdynamic');
  console.log('IsDynamic state:', isDynamic?.checked);
  
  if (isDynamic.checked) {
    video.srcObject = localVideoStream;
    video.play();
    video.onloadedmetadata = () => {
      predictWebcam();
      const croppedStream = backGroundCanvas.captureStream();
      document.getElementById('local_video').srcObject = croppedStream;
      replaceVideoTrack(croppedStream.getVideoTracks()[0]);
    }
  } else {
    replaceVideoTrack(localVideoStream.getVideoTracks()[0]);
    document.getElementById('local_video').srcObject = localVideoStream;
    cancelAnimationFrame(animationTimer);
    cancelAnimationFrame(secDrawAnimTimer);
    video.srcObject = null;
    dummyVideos.srcObject = null;
  }
}


function joinroom() {
  console.log('calling joinroom function');
  const roomname = parseInt(document.getElementById('roomname').value);
  const username = document.getElementById('username').value;
  document.getElementById('login_page').style.display = 'none';
  document.getElementById('meeting_page').style.display = 'block';

  initializeJanus(janusURL, roomname, username, handleJanusEvents);
}

function handleJanusEvents(msg) {
  console.log('Got UpdateUIForVideoEvents, msg:', msg);
  switch(msg.action) {
    case 'addlocalvideo':
      localVideoStream = msg.stream;
      document.getElementById('local_video').srcObject = localVideoStream;
      break;
    case 'removelocalvideo':
      // should we go back to login page 
      break;
    case 'addremote':
      if (msg.mediatype === 'video') {
        document.getElementById('remote_video').srcObject = msg.stream;
        document.getElementById('remoteVideoLabel').style.visibility = 'visible';
      }
      else if (msg.mediatype === 'audio') {
        let audio = new Audio(msg.stream.getAudioTracks()[0]);
        audio.play();
      }
      break;
    case 'removeremote':
      document.getElementById('remote_video').srcObject = null;
      document.getElementById('remoteVideoLabel').style.visibility = 'hidden';
      break;
    case 'registered': 
      (async() => {
        localVideoStream = await navigator.mediaDevices.getUserMedia({audio:false, video:true});
        publishOwnFeed(true, localVideoStream.getVideoTracks()[0]);
      })();
      break;
    default:
      console.warn('Not handled janus msg action:', msg.action)
      break;
  }

}

// Initialize the object detector
const initializefaceDetector = async () => {
  const model = faceDetection.SupportedModels.MediaPipeFaceDetector;
  const detectorConfig = {
    runtime: 'mediapipe',
    modelType: 'full',
    maxFaces: 6,
    solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/face_detection',
  };
  faceDetector = await faceDetection.createDetector(model, detectorConfig);
};
initializefaceDetector();

// Keep a reference of all the child elements we create
// so we can remove them easilly on each render.
let boundingBoxLeftMost = {
  x: Number.MAX_SAFE_INTEGER,
  y: Number.MAX_SAFE_INTEGER,
  width: 0,
  height: 0,
}
let boundingBoxRightMost = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
}
let boundingBoxTopMost = {
  x: Number.MAX_SAFE_INTEGER,
  y: Number.MAX_SAFE_INTEGER,
  width: 0,
  height: 0,
}
let boundingBoxBelowMost = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
}
let boundingBox = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
}

// Prediction loop!
async function predictWebcam() {
  // Now let's start classifying the stream.
  let detections = [];
  if(!isUpdating) {
    try {
      detections = await faceDetector.estimateFaces(video, {flipHorizontal: false});
      ENABLE_LOG && console.log('faces:', detections);
    } catch (error) {
      console.error('error in estimate faces:', error);
    }

    for (let n = 0; n < detections.length; n++) {
      if(detections[n].box.xMin <= boundingBoxLeftMost.x) {
        setBox(boundingBoxLeftMost, detections[n].box);
      }
      if((detections[n].box.xMin + detections[n].box.width)
        > (boundingBoxRightMost.x + boundingBoxRightMost.width)) {
        setBox(boundingBoxRightMost, detections[n].box);
      }
      if(detections[n].box.yMin <= boundingBoxTopMost.y) {
        setBox(boundingBoxTopMost, detections[n].box);
      }
      if((detections[n].box.yMin + detections[n].box.height)
        > (boundingBoxBelowMost.y + boundingBoxBelowMost.height)) {
        setBox(boundingBoxBelowMost, detections[n].box);
      }
    }

    targetBbox = [
      boundingBoxLeftMost.x,
      boundingBoxTopMost.y,
      boundingBoxRightMost.x - boundingBoxLeftMost.x + boundingBoxRightMost.width,
      boundingBoxBelowMost.y - boundingBoxTopMost.y + boundingBoxBelowMost.height,
    ]
    resetBboxes();
    ENABLE_LOG && console.log('targetBbox:', targetBbox, detections.length);

    if(detections.length > 0 && !isUpdating) {
      updateCroppingBoxDimension(targetBbox);
    }
  }

  drawCroppedFrame();
  animationTimer = window.requestAnimationFrame(predictWebcam);
}

function drawCroppedFrame() {
  const context = backGroundCanvas.getContext('2d');
  const x = boundingBox.x - (boundingBox.width / 2);
  const y = boundingBox.y - (boundingBox.height / 1.5);
  let videoWidth = 2 * (boundingBox.x - x) + boundingBox.width;
  let videoHeight = 3 * (boundingBox.y - y) + boundingBox.height;
  videoWidth = x + videoWidth >= video.videoWidth ? video.videoWidth - x : videoWidth;
  videoHeight = y + videoHeight >= video.videoHeight ? video.videoHeight - y : videoHeight;
  const hRatio = backGroundCanvas.width / videoWidth;
  const vRatio = backGroundCanvas.height / videoHeight;
  const ratio = Math.min(hRatio, vRatio);
  const centerShiftX = (backGroundCanvas.width - videoWidth * ratio) / 2;
  const centerShiftY = (backGroundCanvas.height - videoHeight * ratio) / 2;
  context.clearRect(0, 0, backGroundCanvas.width, backGroundCanvas.height);
  context.fillStyle = 'grey';
  context.fillRect(0, 0, backGroundCanvas.width, backGroundCanvas.height);
  context.drawImage(video, parseInt(x, 10), parseInt(y, 10),
    parseInt(videoWidth, 10), parseInt(videoHeight, 10),
    parseInt(centerShiftX, 10), parseInt(centerShiftY, 10),
    parseInt(videoWidth * ratio, 10), parseInt(videoHeight * ratio, 10)
  );
}

function updateCroppingBoxDimension(bbox) {
  ENABLE_LOG && console.log('updateCroppingBoxDimension:latest changes:', bbox);
  if(isFirstTimeBboxCalculation()) {
    boundingBox.x = bbox[0];
    boundingBox.y = bbox[1];
    boundingBox.width = bbox[2];
    boundingBox.height = bbox[3];
    ENABLE_LOG && console.log('updateCroppingBoxDimension: first time hence returning');
    return;
  }
  ENABLE_LOG && console.log('updateCroppingBoxDimension:current bbox:', bbox, ' previous:', boundingBox);
  const xDiff = parseInt(bbox[0] - boundingBox.x, 10);
  const yDiff = parseInt(bbox[1] - boundingBox.y, 10);
  const widthDiff = parseInt(bbox[2] - boundingBox.width, 10);
  const heightDiff = parseInt(bbox[3] - boundingBox.height, 10);
  if(Math.abs(xDiff) <= DISPLACEMENT_IGNORED || Math.abs(yDiff) <= DISPLACEMENT_IGNORED ||
    Math.abs(widthDiff) <= DISPLACEMENT_IGNORED || Math.abs(heightDiff) <= DISPLACEMENT_IGNORED) {
      ENABLE_LOG && console.log('updateCroppingBoxDimension:ignoring displacement, returning');
      return;
  }
  ENABLE_LOG && console.log('updateCroppingBoxDimension::xDiff, yDiff, widthDiff, heightDiff:', xDiff, yDiff, widthDiff, heightDiff);
  isUpdating = true;
  clearInterval(animationIntervalId);
  animationIntervalId = setInterval(() => {
    updateBbox(xDiff, yDiff, widthDiff, heightDiff);
  }, ANIMATION_INETRVAL);
}

function updateBbox(xDiff, yDiff, widthDiff, heightDiff) {
  ENABLE_LOG && console.log('updateBbox: xDiff, yDiff, widthDiff, heightDiff:', xDiff, yDiff, widthDiff, heightDiff);
  const xDx = Math.abs(xDiff/ANIMATION_SPEED);
  const yDy = Math.abs(yDiff/ANIMATION_SPEED);
  const wDw = Math.abs(widthDiff/ANIMATION_SPEED);
  const hDh = Math.abs(heightDiff/ANIMATION_SPEED);
  // Check if the bbox has reached the target size
  if (
    getAbsDiff(boundingBox.x, targetBbox[0]) < xDx && getAbsDiff(boundingBox.y, targetBbox[1]) < yDy && 
    getAbsDiff(boundingBox.width, targetBbox[2]) < wDw && getAbsDiff(boundingBox.height, targetBbox[3]) < hDh
  ) {
    clearInterval(animationIntervalId);
    isUpdating = false;
  }
  if (getAbsDiff(boundingBox.x, targetBbox[0]) >= xDx) {
    ENABLE_LOG && console.log('x diff:', getAbsDiff(boundingBox.x, targetBbox[0]));
    boundingBox.x += xDiff/ANIMATION_SPEED;
  }
  if (getAbsDiff(boundingBox.y, targetBbox[1]) >= yDy) {
    ENABLE_LOG && console.log('y diff:', getAbsDiff(boundingBox.y, targetBbox[1]));
    boundingBox.y += yDiff/ANIMATION_SPEED;
  }
  if (getAbsDiff(boundingBox.width, targetBbox[2]) >= wDw) {
    ENABLE_LOG && console.log('width diff:', getAbsDiff(boundingBox.width, targetBbox[2]));
    boundingBox.width += widthDiff/ANIMATION_SPEED;
  }
  if (getAbsDiff(boundingBox.height, targetBbox[3]) >= hDh) {
    ENABLE_LOG && console.log('height diff:', getAbsDiff(boundingBox.height, targetBbox[3]));
    boundingBox.height += heightDiff/ANIMATION_SPEED;
  }
  ENABLE_LOG && console.log('updateBbox x:', boundingBox.x, targetBbox[0], ' y:', boundingBox.y, targetBbox[1],
  ' width:', boundingBox.width, targetBbox[2], ' height:', boundingBox.height, targetBbox[3]);
}


//----------------------------------------------Utils--------------------------------------------------------

function getAbsDiff(a, b) {
  return parseInt(Math.abs(a-b), 10);
}

function isFirstTimeBboxCalculation () {
  return boundingBox.x === 0 && boundingBox.y === 0 && boundingBox.width === 0 && boundingBox.height === 0;
}

function resetBboxes() {
  boundingBoxLeftMost.x = Number.MAX_SAFE_INTEGER;
  boundingBoxLeftMost.y = Number.MAX_SAFE_INTEGER;
  boundingBoxLeftMost.width = 0;
  boundingBoxLeftMost.height = 0;

  boundingBoxRightMost.x = 0
  boundingBoxRightMost.y = 0;
  boundingBoxRightMost.width = 0;
  boundingBoxRightMost.height = 0;

  boundingBoxTopMost.x = Number.MAX_SAFE_INTEGER;;
  boundingBoxTopMost.y = Number.MAX_SAFE_INTEGER;
  boundingBoxTopMost.width = 0;
  boundingBoxTopMost.height = 0;

  boundingBoxBelowMost.x = 0;
  boundingBoxBelowMost.y = 0;
  boundingBoxBelowMost.width = 0;
  boundingBoxBelowMost.height = 0;
}

function setBox(localBox, boundingBox) {
  localBox.x = boundingBox.xMin;
  localBox.y = boundingBox.yMin;
  localBox.width = boundingBox.width;
  localBox.height = boundingBox.height;
}