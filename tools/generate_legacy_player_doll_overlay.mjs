import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const overlayName = "overlay_1_21_11_to_1_21_6";
const overlayRoot = path.join(repoRoot, overlayName);
const itemRoot = path.join(repoRoot, "assets", "minecraft", "items", "custom");
const modelRoot = path.join(repoRoot, "assets", "minecraft", "models");
const overlayItemRoot = path.join(overlayRoot, "assets", "minecraft", "items", "custom");
const overlayModelRoot = path.join(overlayRoot, "assets", "minecraft", "models");
const dollBaseModel = readJson(path.join(modelRoot, "item", "custom", "player_doll", "base.json"));
const displayContexts = {
  ...dollBaseModel.display,
  // Added in 1.21.9. Earlier versions safely ignore the unknown display context.
  on_shelf: {
    rotation: [0, 0, 0],
    translation: [0, 0, 0],
    scale: [1, 1, 1]
  }
};

const generatedFiles = new Set();
const stats = { items: 0, wrappers: 0 };

for (const style of ["classic", "slim"]) {
  generateLegacyItem(style);
}

removeStaleGeneratedFiles(overlayRoot, generatedFiles);
console.log(`Generated ${stats.items} legacy item definitions and ${stats.wrappers} model wrappers.`);

function generateLegacyItem(style) {
  const itemName = `player_doll__${style}.json`;
  const sourcePath = path.join(itemRoot, itemName);
  const outputPath = path.join(overlayItemRoot, itemName);
  const item = readJson(sourcePath);

  for (const part of item.model.models) {
    if (!part.transformation) continue;

    const pose = part.transformation;
    const legacyDisplay = composeLegacyDisplay(pose);
    delete part.transformation;

    walk(part, (node) => {
      if (node.type !== "model" || typeof node.model !== "string") return;
      if (node.model === "item/custom/player_doll/empty") return;

      const sourceModel = node.model;
      const legacyModel = sourceModel.replace(
        "item/custom/player_doll/",
        "item/custom/player_doll_legacy/"
      );
      if (legacyModel === sourceModel) {
        throw new Error(`Unexpected player doll model path: ${sourceModel}`);
      }

      node.model = legacyModel;
      const wrapperPath = path.join(overlayModelRoot, `${legacyModel}.json`);
      writeGeneratedJson(wrapperPath, {
        parent: sourceModel,
        display: legacyDisplay
      });
      stats.wrappers += 1;
    });
  }

  writeGeneratedJson(outputPath, item);
  stats.items += 1;
}

function composeLegacyDisplay(pose) {
  assertSupportedPose(pose);
  const poseTranslation = pose.translation;
  const poseRotation = normalizeQuaternion(
    multiplyQuaternions(pose.left_rotation, pose.right_rotation)
  );
  const output = {};

  for (const [context, display] of Object.entries(displayContexts)) {
    const leftHand = context.endsWith("_lefthand");
    const displayScale = display.scale;
    if (!nearlyEqual(displayScale[0], displayScale[1]) ||
        !nearlyEqual(displayScale[1], displayScale[2])) {
      throw new Error(`Non-uniform display scale is not supported for ${context}`);
    }

    const scale = displayScale[0];
    const runtimeTranslation = [
      (leftHand ? -display.translation[0] : display.translation[0]) / 16,
      display.translation[1] / 16,
      display.translation[2] / 16
    ];
    const runtimeEuler = [
      display.rotation[0],
      leftHand ? -display.rotation[1] : display.rotation[1],
      leftHand ? -display.rotation[2] : display.rotation[2]
    ];
    const displayRotation = quaternionFromEulerXYZ(runtimeEuler);
    const combinedRotation = normalizeQuaternion(
      multiplyQuaternions(displayRotation, poseRotation)
    );

    // Item display transforms are T * R * S * T(-0.5). The 26.1+
    // item-model transform is multiplied after that, so solve for the legacy
    // display translation that produces exactly D * P for every model vertex.
    const beforePose = rotateVector(
      displayRotation,
      scaleVector(addVectors([-0.5, -0.5, -0.5], poseTranslation), scale)
    );
    const recenter = rotateVector(
      combinedRotation,
      scaleVector([0.5, 0.5, 0.5], scale)
    );
    const combinedTranslation = addVectors(runtimeTranslation, beforePose, recenter);
    const combinedEuler = eulerXYZFromQuaternion(combinedRotation);

    const encoded = {
      rotation: roundVector([
        combinedEuler[0],
        leftHand ? -combinedEuler[1] : combinedEuler[1],
        leftHand ? -combinedEuler[2] : combinedEuler[2]
      ]),
      translation: roundVector([
        (leftHand ? -combinedTranslation[0] : combinedTranslation[0]) * 16,
        combinedTranslation[1] * 16,
        combinedTranslation[2] * 16
      ]),
      scale: displayScale
    };

    verifyEquivalentTransform(display, pose, encoded, leftHand, context);
    output[context] = encoded;
  }

  return output;
}

function verifyEquivalentTransform(display, pose, encoded, leftHand, context) {
  const originalDisplay = decodeItemDisplayTransform(display, leftHand);
  const legacyDisplay = decodeItemDisplayTransform(encoded, leftHand);
  const poseRotation = normalizeQuaternion(
    multiplyQuaternions(pose.left_rotation, pose.right_rotation)
  );
  const sampleVertices = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 1, 1],
    [0.25, 0.5, 0.75]
  ];

  for (const vertex of sampleVertices) {
    const posed = addVectors(rotateVector(poseRotation, vertex), pose.translation);
    const expected = applyItemDisplayTransform(originalDisplay, posed);
    const actual = applyItemDisplayTransform(legacyDisplay, vertex);
    const error = Math.max(...expected.map((value, index) => Math.abs(value - actual[index])));
    if (error > 2e-6) {
      throw new Error(`Legacy transform mismatch in ${context}: ${error}`);
    }
  }
}

function decodeItemDisplayTransform(display, leftHand) {
  const rotation = [
    display.rotation[0],
    leftHand ? -display.rotation[1] : display.rotation[1],
    leftHand ? -display.rotation[2] : display.rotation[2]
  ];
  return {
    rotation: quaternionFromEulerXYZ(rotation),
    translation: [
      (leftHand ? -display.translation[0] : display.translation[0]) / 16,
      display.translation[1] / 16,
      display.translation[2] / 16
    ],
    scale: display.scale
  };
}

function applyItemDisplayTransform(transform, vertex) {
  const centered = addVectors(vertex, [-0.5, -0.5, -0.5]);
  const scaled = multiplyVectors(centered, transform.scale);
  return addVectors(transform.translation, rotateVector(transform.rotation, scaled));
}

function assertSupportedPose(pose) {
  if (!pose.translation || !pose.left_rotation || !pose.scale || !pose.right_rotation) {
    throw new Error("Incomplete player doll transformation");
  }
  const identity = [0, 0, 0, 1];
  if (Math.max(...pose.left_rotation.map((value, index) => Math.abs(value - identity[index]))) > 1e-6) {
    throw new Error("Legacy generator currently requires an identity left rotation");
  }
  if (Math.max(...pose.scale.map((value) => Math.abs(value - 1))) > 1e-6) {
    throw new Error("Legacy generator currently requires a unit pose scale");
  }
}

function quaternionFromEulerXYZ(degrees) {
  const [x, y, z] = degrees.map((value) => value * Math.PI / 180 / 2);
  const sx = Math.sin(x), cx = Math.cos(x);
  const sy = Math.sin(y), cy = Math.cos(y);
  const sz = Math.sin(z), cz = Math.cos(z);
  return normalizeQuaternion([
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz
  ]);
}

function eulerXYZFromQuaternion(quaternion) {
  const [x, y, z, w] = normalizeQuaternion(quaternion);
  const radians = [
    Math.atan2(x * w - y * z, 0.5 - x * x - y * y),
    Math.asin(clamp(2 * (x * z + y * w), -1, 1)),
    Math.atan2(z * w - x * y, 0.5 - y * y - z * z)
  ];
  return radians.map((value) => value * 180 / Math.PI);
}

function multiplyQuaternions(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}

function normalizeQuaternion(quaternion) {
  const length = Math.hypot(...quaternion);
  return quaternion.map((value) => value / length);
}

function rotateVector(quaternion, vector) {
  const [qx, qy, qz, qw] = quaternion;
  const [vx, vy, vz] = vector;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx)
  ];
}

function walk(value, visitor) {
  if (!value || typeof value !== "object") return;
  visitor(value);
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visitor);
  } else {
    for (const child of Object.values(value)) walk(child, visitor);
  }
}

function writeGeneratedJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
  generatedFiles.add(path.resolve(filePath));
}

function removeStaleGeneratedFiles(root, expectedFiles) {
  if (!fs.existsSync(root)) return;
  for (const filePath of listFiles(root)) {
    if (!expectedFiles.has(filePath)) fs.rmSync(filePath);
  }
  removeEmptyDirectories(root);
}

function listFiles(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...listFiles(entryPath));
    else if (entry.isFile()) output.push(entryPath);
  }
  return output;
}

function removeEmptyDirectories(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name));
  }
  if (directory !== overlayRoot && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function addVectors(...vectors) {
  return vectors.reduce(
    (sum, vector) => sum.map((value, index) => value + vector[index]),
    [0, 0, 0]
  );
}

function scaleVector(vector, scalar) {
  return vector.map((value) => value * scalar);
}

function multiplyVectors(a, b) {
  return a.map((value, index) => value * b[index]);
}

function roundVector(vector) {
  return vector.map((value) => {
    const rounded = Math.round(value * 1e8) / 1e8;
    return Object.is(rounded, -0) ? 0 : rounded;
  });
}

function nearlyEqual(a, b) {
  return Math.abs(a - b) < 1e-8;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
