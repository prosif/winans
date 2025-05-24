//const axios = require("axios");
const tf = require("@tensorflow/tfjs-node");
const nsfw = require("nsfwjs");
const { extractThumbnails } = require('./video_utils');

async function fn() {
  try {
    
    // Save the video temporarily
    const fs = require('fs');

    // Extract thumbnails
    const thumbnails = await extractThumbnails('/Users/josephgarcia/cleancopy/nsfw_test.mp4', 5);
    console.log('Generated thumbnails:', thumbnails);

    // Load the NSFW model
    const model = await nsfw.load('http://localhost:7001/models/mobilenet_v2/');

    // Process each thumbnail
    for (const thumbnailPath of thumbnails) {
      const image = await tf.node.decodeImage(fs.readFileSync(thumbnailPath), 3);
      const predictions = await model.classify(image);
      console.log(`Predictions for ${thumbnailPath}:`, predictions);
      image.dispose();
    }

    // Clean up temporary files
//    fs.unlinkSync(videoPath);
    for (const thumbnail of thumbnails) {
//      fs.unlinkSync(thumbnail);
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

fn();
