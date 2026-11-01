/*
 * Browser extraction of the AcerolaFX ASCII effect.
 *
 * The original effect is MIT licensed. It lives in
 * ../Shaders/AcerolaFX_ASCII.fx and was written for ReShade/HLSL.
 * This file keeps the parts that are useful for image/video content on
 * the web: an 8x8 character tile, luminance quantization, Sobel-like
 * direction buckets, and dominant edge selection.
 */

const TILE_SIZE = 8;
const LUMINANCE_R = 0.2127;
const LUMINANCE_G = 0.7152;
const LUMINANCE_B = 0.0722;
const PI = Math.PI;

// The source shader stores rasterized glyphs in fillASCII.png rather than a
// literal string. Its last 8x8 cell is a fully filled bitmap. The web text
// renderer uses the requested density ramp; the final @ is followed by a
// solid-square glyph for the highest level.
const ASCII_FILL_CHARACTERS = ' .iCOP0?@■';

const DEFAULT_OPTIONS = {
  // The source shader renders one character for every 8x8 pixel tile.
  columns: 96,
  tileSize: TILE_SIZE,

  // These values only affect the canvas text rasterization, not sampling.
  // Silkscreen is designed as an 8px bitmap font; 16px keeps a crisp 2x grid.
  fontSize: 16,
  lineHeight: 1,
  fontFamily:
    '"Silkscreen", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',

  drawEdges: true,
  drawFill: true,
  edgeThreshold: 8,
  edgeSensitivity: 0.095,
  exposure: 1,
  attenuation: 1,
  invertLuminance: false,

  asciiColor: '#9dffd0',
  backgroundColor: '#06110c',
  blendWithSource: 0,

  // A small optional animation for a static image demo. Keep this at zero
  // when the input itself is already animated and exact source luminance is
  // preferred.
  shimmer: 0,
  shimmerSpeed: 0.8,

  // The two LUTs in the original shader contain ten fill cells and four
  // directional edge cells. Text output needs a character equivalent.
  fillCharacters: ASCII_FILL_CHARACTERS,
  edgeCharacters: '|-/\\',
};

const clamp = (value, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

function sourceSize(source) {
  if (!source) return null;

  const width = source.videoWidth || source.naturalWidth || source.width;
  const height = source.videoHeight || source.naturalHeight || source.height;

  if (!width || !height) return null;
  return { width, height };
}

function cssColorToRgb(color) {
  if (Array.isArray(color) && color.length >= 3) {
    return color.slice(0, 3).map((channel) =>
      channel > 1 ? channel / 255 : channel,
    );
  }

  if (typeof color !== 'string') return [1, 1, 1];

  const value = color.trim().toLowerCase();
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      return [0, 1, 2].map((index) =>
        parseInt(hex[index] + hex[index], 16) / 255,
      );
    }
    if (hex.length === 6 || hex.length === 8) {
      return [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
    }
  }

  const rgb = value.match(
    /^rgba?\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)/,
  );
  if (rgb) {
    return rgb.slice(1, 4).map((channel) =>
      channel.endsWith('%')
        ? parseFloat(channel) / 100
        : parseFloat(channel) / 255,
    );
  }

  // The demo uses hex colors. For arbitrary CSS names, let the canvas keep
  // using the original color and use white as the best blend approximation.
  return [1, 1, 1];
}

function rgbToCss(rgb) {
  return `rgb(${Math.round(clamp(rgb[0]) * 255)}, ${Math.round(
    clamp(rgb[1]) * 255,
  )}, ${Math.round(clamp(rgb[2]) * 255)})`;
}

function classifyDirection(theta) {
  const absTheta = Math.abs(theta) / PI;

  // This is the same angle partition used by CS_RenderASCII in the source
  // shader: vertical, horizontal, and the two diagonal directions.
  if (absTheta < 0.05 || absTheta > 0.9) return 0;
  if (absTheta > 0.45 && absTheta < 0.55) return 1;
  if (absTheta > 0.05 && absTheta < 0.45) return theta > 0 ? 3 : 2;
  if (absTheta > 0.55 && absTheta < 0.9) return theta > 0 ? 2 : 3;

  return -1;
}

function directionFromBuckets(buckets, threshold) {
  let direction = -1;
  let maxValue = 0;

  // A strict comparison deliberately preserves the shader's lower-index tie
  // break. Direction 0 wins when two directions have the same count.
  for (let index = 0; index < buckets.length; index += 1) {
    if (buckets[index] > maxValue) {
      direction = index;
      maxValue = buckets[index];
    }
  }

  return maxValue >= threshold ? direction : -1;
}

function getCharacter(characters, index, fallback = ' ') {
  if (typeof characters !== 'string' || characters.length === 0) return fallback;
  return characters[index] || characters[characters.length - 1] || fallback;
}

function drawCharacter(context, character, x, y, cellWidth, cellHeight) {
  if (character === '■') {
    // Silkscreen intentionally does not contain U+25A0. Draw the final LUT
    // cell ourselves so it remains a crisp, square block rather than falling
    // back to a proportional system glyph.
    const size = Math.max(1, Math.floor(Math.min(cellWidth, cellHeight) * 0.75));
    const offsetX = Math.floor((cellWidth - size) / 2);
    const offsetY = Math.floor((cellHeight - size) / 2);
    context.fillRect(x + offsetX, y + offsetY, size, size);
    return;
  }

  context.fillText(character, x, y);
}

/**
 * Render a source image, video, canvas, or ImageBitmap as animated ASCII.
 *
 * The renderer deliberately targets a canvas instead of a DOM <pre>. A
 * browser can update a canvas containing a few thousand glyphs every frame;
 * creating thousands of DOM text nodes or spans cannot reliably do that.
 */
export class AcerolaAsciiRenderer {
  constructor(canvas, options = {}) {
    if (!canvas || canvas.nodeName !== 'CANVAS') {
      throw new TypeError('AcerolaAsciiRenderer needs a <canvas> target.');
    }

    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false });
    this.sampleCanvas = document.createElement('canvas');
    this.sampleContext = this.sampleCanvas.getContext('2d', { alpha: false });
    this.options = { ...DEFAULT_OPTIONS, ...options };

    this._raf = 0;
    this._running = false;
    this._source = null;
    this._layout = null;
    this._luminance = new Float32Array(0);
    this._frame = '';
    this._asciiRgb = cssColorToRgb(this.options.asciiColor);
    this._backgroundRgb = cssColorToRgb(this.options.backgroundColor);
  }

  /** Update options without interrupting an active animation loop. */
  setOptions(nextOptions = {}) {
    Object.assign(this.options, nextOptions);
    this._asciiRgb = cssColorToRgb(this.options.asciiColor);
    this._backgroundRgb = cssColorToRgb(this.options.backgroundColor);
    this._layout = null;
  }

  /** Start a requestAnimationFrame loop for an image, video, or canvas source. */
  start(source = this._source) {
    this.stop();
    this._source = source;
    this._running = true;

    const tick = (timestamp) => {
      if (!this._running) return;
      this.render(this._source, timestamp / 1000);
      this._raf = requestAnimationFrame(tick);
    };

    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  get running() {
    return this._running;
  }

  /** The most recently generated text frame, useful for accessibility/debugging. */
  get text() {
    return this._frame;
  }

  /** Render one frame. Returns false when the source has not loaded yet. */
  render(source = this._source, timeSeconds = 0) {
    const size = sourceSize(source);
    if (!size) return false;

    this._source = source;
    this._ensureLayout(size.width, size.height);

    const { sampleWidth, sampleHeight } = this._layout;
    this.sampleContext.imageSmoothingEnabled = true;
    this.sampleContext.clearRect(0, 0, sampleWidth, sampleHeight);

    try {
      this.sampleContext.drawImage(source, 0, 0, sampleWidth, sampleHeight);
    } catch (error) {
      // drawImage throws while a video is still waiting for its first frame.
      if (source.readyState !== undefined && source.readyState < 2) return false;
      throw error;
    }

    let pixels;
    try {
      pixels = this.sampleContext.getImageData(0, 0, sampleWidth, sampleHeight);
    } catch (error) {
      // This usually means a cross-origin image/video was not served with
      // CORS headers. Keep the error actionable for callers.
      error.message = `Unable to read the source pixels. Use same-origin media or enable CORS. ${error.message}`;
      throw error;
    }

    this._updateLuminance(pixels.data);
    this._drawFrame(pixels.data, timeSeconds);
    return true;
  }

  _ensureLayout(sourceWidth, sourceHeight) {
    const columns = Math.max(1, Math.round(Number(this.options.columns) || 1));
    const fontSize = Math.max(8, Number(this.options.fontSize) || 15);
    const lineHeight = Math.max(0.75, Number(this.options.lineHeight) || 1);
    const font = `${fontSize}px ${this.options.fontFamily}`;

    // Measure a real monospace glyph so characters stay in their cells even
    // when the browser substitutes a platform-specific monospace font.
    this.context.font = font;
    const measuredWidth = this.context.measureText('M').width || fontSize * 0.6;
    const cellWidth = Math.max(1, Math.ceil(measuredWidth));
    const cellHeight = Math.max(1, Math.ceil(fontSize * lineHeight));
    const rows = Math.max(
      1,
      Math.round(
        columns *
          (sourceHeight / sourceWidth) *
          (cellWidth / cellHeight),
      ),
    );

    const old = this._layout;
    if (
      old &&
      old.columns === columns &&
      old.rows === rows &&
      old.font === font
    ) {
      return;
    }

    const tileSize = Math.max(2, Math.round(Number(this.options.tileSize) || TILE_SIZE));
    const sampleWidth = columns * tileSize;
    const sampleHeight = rows * tileSize;

    this.canvas.width = columns * cellWidth;
    this.canvas.height = rows * cellHeight;
    this.sampleCanvas.width = sampleWidth;
    this.sampleCanvas.height = sampleHeight;

    this._layout = {
      columns,
      rows,
      tileSize,
      sampleWidth,
      sampleHeight,
      cellWidth,
      cellHeight,
      font,
    };
    this._luminance = new Float32Array(sampleWidth * sampleHeight);
  }

  _updateLuminance(data) {
    const { sampleWidth, sampleHeight } = this._layout;
    const background = this._backgroundRgb;

    for (let y = 0; y < sampleHeight; y += 1) {
      for (let x = 0; x < sampleWidth; x += 1) {
        const pixel = (y * sampleWidth + x) * 4;
        const alpha = data[pixel + 3] / 255;
        const r = data[pixel] / 255 * alpha + background[0] * (1 - alpha);
        const g = data[pixel + 1] / 255 * alpha + background[1] * (1 - alpha);
        const b = data[pixel + 2] / 255 * alpha + background[2] * (1 - alpha);
        this._luminance[y * sampleWidth + x] = Math.max(
          0.00001,
          r * LUMINANCE_R + g * LUMINANCE_G + b * LUMINANCE_B,
        );
      }
    }
  }

  _sample(x, y) {
    const { sampleWidth, sampleHeight } = this._layout;
    const clampedX = Math.max(0, Math.min(sampleWidth - 1, x));
    const clampedY = Math.max(0, Math.min(sampleHeight - 1, y));
    return this._luminance[clampedY * sampleWidth + clampedX];
  }

  _drawFrame(data, timeSeconds) {
    const {
      columns,
      rows,
      tileSize,
      sampleWidth,
      sampleHeight,
      cellWidth,
      cellHeight,
      font,
    } = this._layout;
    const options = this.options;
    const context = this.context;
    const background = options.backgroundColor;
    const asciiRgb = this._asciiRgb;
    const blend = clamp(Number(options.blendWithSource) || 0);
    const fillCharacters = options.fillCharacters;
    const edgeCharacters = options.edgeCharacters;
    const lines = [];

    context.save();
    context.fillStyle = background;
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.font = font;
    context.textBaseline = 'top';
    context.textAlign = 'left';

    for (let row = 0; row < rows; row += 1) {
      let line = '';

      for (let column = 0; column < columns; column += 1) {
        const startX = column * tileSize;
        const startY = row * tileSize;
        let averageLuminance = 0;
        let averageR = 0;
        let averageG = 0;
        let averageB = 0;
        let pixelCount = 0;
        const buckets = [0, 0, 0, 0];

        for (let localY = 0; localY < tileSize; localY += 1) {
          const y = startY + localY;
          for (let localX = 0; localX < tileSize; localX += 1) {
            const x = startX + localX;
            const pixel = (y * sampleWidth + x) * 4;
            averageLuminance += this._luminance[y * sampleWidth + x];
            averageR += data[pixel] / 255;
            averageG += data[pixel + 1] / 255;
            averageB += data[pixel + 2] / 255;
            pixelCount += 1;

            // The source shader first creates a binary edge buffer and then
            // classifies the Sobel direction. The browser fallback has no
            // scene depth/normal buffers, so a luminance gradient is the
            // portable substitute.
            const gx =
              (this._sample(x + 1, y) - this._sample(x - 1, y)) * 0.5;
            const gy =
              (this._sample(x, y + 1) - this._sample(x, y - 1)) * 0.5;
            const magnitude = Math.sqrt(gx * gx + gy * gy);

            if (magnitude >= Number(options.edgeSensitivity)) {
              const direction = classifyDirection(Math.atan2(gy, gx));
              if (direction >= 0) buckets[direction] += 1;
            }
          }
        }

        averageLuminance /= pixelCount;
        averageR /= pixelCount;
        averageG /= pixelCount;
        averageB /= pixelCount;

        if (options.shimmer) {
          const phase =
            timeSeconds * Number(options.shimmerSpeed || 0) +
            column * 0.17 +
            row * 0.11;
          averageLuminance = clamp(
            averageLuminance * (1 + Math.sin(phase) * Number(options.shimmer)),
          );
        }

        let character = ' ';
        const edgeDirection = directionFromBuckets(
          buckets,
          Math.max(0, Math.round(Number(options.edgeThreshold) || 0)),
        );

        if (options.drawEdges && edgeDirection >= 0) {
          character = getCharacter(edgeCharacters, edgeDirection);
        } else if (options.drawFill) {
          let luminance = clamp(
            Math.pow(
              averageLuminance * Math.max(0, Number(options.exposure) || 0),
              Math.max(0, Number(options.attenuation) || 0),
            ),
          );
          if (options.invertLuminance) luminance = 1 - luminance;

          // This is the source shader's ten-step quantizer:
          // max(0, floor(luminance * 10) - 1) / 10.
          const level = Math.max(0, Math.min(9, Math.floor(luminance * 10) - 1));
          character = getCharacter(fillCharacters, level);
        }

        line += character;

        if (character !== ' ') {
          const sourceRgb = [averageR, averageG, averageB];
          const color = [
            asciiRgb[0] * (1 - blend) + sourceRgb[0] * blend,
            asciiRgb[1] * (1 - blend) + sourceRgb[1] * blend,
            asciiRgb[2] * (1 - blend) + sourceRgb[2] * blend,
          ];
          context.fillStyle = blend > 0 ? rgbToCss(color) : options.asciiColor;
          drawCharacter(
            context,
            character,
            column * cellWidth,
            row * cellHeight,
            cellWidth,
            cellHeight,
          );
        }
      }

      lines.push(line);
    }

    context.restore();
    this._frame = lines.join('\n');
  }
}

export { ASCII_FILL_CHARACTERS, DEFAULT_OPTIONS, classifyDirection };
