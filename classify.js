const nsfw = require('nsfwjs');
const tf = require('@tensorflow/tfjs-node');
const fs = require('fs');
const path = require('path');

(async () => {
  const imagePath = process.argv[2];

  if (!imagePath) {
    console.error("Error: No image path provided.");
    process.exit(1);
  }

  try {
    // Load model from local path using direct file path
    const modelPath = path.resolve(__dirname, 'models', 'mobilenet_v2', 'model.json');
    const model = await nsfw.load('file://./models/mobilenet_v2/model.json');//http://localhost:7000/models/mobilenet_v2/model.json');
    
    // Read and decode image
    const image = fs.readFileSync(imagePath);
    const imageTensor = tf.node.decodeImage(image, 3);
    
    // Classify image
    const predictions = await model.classify(imageTensor);
    console.log(`Predictions for ${imagePath}:`, predictions);
    
    // Clean up tensors
    imageTensor.dispose();
  } catch (err) {
    console.error("Failed to classify image:", err);
    process.exit(1);
  }
})();
