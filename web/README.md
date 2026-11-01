# Browser ASCII extraction

This folder is a dependency-free browser version of the ASCII idea in
`../Shaders/AcerolaFX_ASCII.fx`.

## Run the demo

From the repository root:

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000/web/>. A local HTTP server is needed because the
module and the default image are loaded by the browser as separate files.

The demo accepts local images and videos. Video frames are sampled on every
`requestAnimationFrame`; a static image can use the optional `shimmer` setting
for a restrained animated treatment.

## Minimal integration

```html
<canvas id="ascii"></canvas>
<script type="module">
  import { AcerolaAsciiRenderer } from './ascii-renderer.js';

  const image = new Image();
  image.src = '/Textures/example.png';
  image.onload = () => {
    const renderer = new AcerolaAsciiRenderer(
      document.querySelector('#ascii'),
      {
        columns: 110,
        edgeThreshold: 8,
        exposure: 1.2,
        attenuation: 1,
        asciiColor: '#9dffd0',
        backgroundColor: '#06110c',
      },
    );
    renderer.start(image);
  };
</script>
```

The renderer also accepts an `HTMLVideoElement`, `HTMLCanvasElement`, or
`ImageBitmap`. Change controls while it is running with
`renderer.setOptions({ exposure: 1.5, drawEdges: false })`.

For accessibility or a DOM `<pre>` fallback, the latest character frame is
available as `renderer.text`. Canvas is used for the normal display because
thousands of DOM nodes are not a good animation primitive.

## Important limitation

The original ReShade effect receives a game color buffer, depth buffer, and
normal information. A normal image/video element only has color pixels. This
extraction therefore uses a luminance gradient for edge detection. See
[`../ASCII_WEB_EXTRACTION.md`](../ASCII_WEB_EXTRACTION.md) for the pass-by-pass
analysis and the route to an exact WebGL2/WebGPU port.
