/**
 * 3D 预览的 three.js 场景：渲染器、相机取景、光照、地面网格、按需渲染、资源释放。
 *
 * 与 React 解耦，因为这里全是**命令式**资源：卸载时必须显式 dispose 几何/材质/贴图/renderer，
 * 否则连开几个模型会撞上浏览器的 WebGL 上下文上限。
 */
import {
  ACESFilmicToneMapping,
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { disposeObject3D } from "@/modelPreview/modelPreviewLoaders.js";

const CAMERA_DIRECTION = new Vector3(1, 0.72, 1).normalize();
/** 取景余量：贴边取景会被底部的信息行压住，也给"这是整个模型"留出呼吸。 */
const FRAME_MARGIN = 1.25;
/** 场景内参照物（地面网格）配色：WebGL 读不到 CSS 变量，按主题取固定中性色。 */
const GRID_COLORS = {
  light: { center: 0xb7c0cd, grid: 0xd9dfe7 },
  dark: { center: 0x4b5563, grid: 0x333a45 },
} as const;

export interface ModelPreviewStats {
  triangles: number;
  size: { x: number; y: number; z: number };
}

export function createScene(
  canvas: HTMLCanvasElement,
  theme: "light" | "dark",
  onContextLost: () => void,
) {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ alpha: true, antialias: true, canvas });
  } catch {
    // 没有可用的 WebGL（旧显卡、驱动黑名单、上下文耗尽）时由调用方展示错误态。
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = ACESFilmicToneMapping;

  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, canvas);
  // 不开 damping：three 的 dampingFactor 默认 0.05，每帧只消化 5% 的剩余量，
  // 相机永远追在鼠标后面（真机反馈"旋转不跟手/不跟鼠标"）。预览要的是 1:1 跟随。
  controls.enableDamping = false;

  // 半球光给环境底子，主光定形，补光提暗部；再加房间环境贴图，让金属/粗糙度材质有反射可看。
  const hemisphere = new HemisphereLight(0xffffff, 0x505a66, 1.5);
  const keyLight = new DirectionalLight(0xffffff, 1.9);
  keyLight.position.set(1.8, 2.6, 2);
  const fillLight = new DirectionalLight(0xffffff, 0.55);
  fillLight.position.set(-2.2, 0.8, -1.6);
  scene.add(hemisphere, keyLight, fillLight);

  const pmrem = new PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;
  scene.environmentIntensity = 0.45;

  const colors = GRID_COLORS[theme];
  let grid = new GridHelper(2, 20, new Color(colors.center), new Color(colors.grid));
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  grid.material.depthWrite = false;
  scene.add(grid);

  let disposed = false;
  let pendingFrame: number | null = null;
  let loopFrame: number | null = null;
  let interacting = false;
  let content: Object3D | null = null;
  let fit: { center: Vector3; radius: number } | null = null;

  const draw = () => {
    if (!disposed) {
      renderer.render(scene, camera);
    }
  };

  const redraw = () => {
    if (disposed || pendingFrame !== null) {
      return;
    }
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      draw();
    });
  };

  /** 按包围盒自动取景：竖屏时水平视野更窄，取两者较小者才能保证长边也被装进画面。 */
  const applyFit = () => {
    if (!fit) {
      return;
    }
    // 先 update 一次把拖拽残留的 delta 消化掉（没有阻尼时 update() 会清空它），
    // 否则"重置视角"会被刚才拖拽的残余量顶偏。
    controls.update();

    const vertical = (camera.fov * Math.PI) / 180;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(camera.aspect, 0.0001));
    const distance = (fit.radius / Math.sin(Math.min(vertical, horizontal) / 2)) * FRAME_MARGIN;
    camera.near = Math.max(fit.radius / 500, 0.01);
    camera.far = distance + fit.radius * 20;
    camera.position.copy(fit.center).addScaledVector(CAMERA_DIRECTION, distance);
    camera.updateProjectionMatrix();
    controls.target.copy(fit.center);
    controls.minDistance = fit.radius * 0.05;
    controls.maxDistance = distance * 12;
    controls.update();
  };

  const resize = () => {
    if (disposed) {
      return;
    }
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // 容器宽度变化会改变水平视野，取景要重算，否则窄侧栏里模型会被裁掉。
    applyFit();
    draw();
  };

  /**
   * OrbitControls 只在调用 `update()` 时才把拖拽/缩放累积量写进相机（默认假设宿主有渲染循环）。
   * 静态模型不该常驻跑帧，所以只在**交互期间**跑循环：按下时起、松手即停。
   */
  const tick = () => {
    loopFrame = null;
    if (disposed || !interacting) {
      return;
    }
    controls.update();
    draw();
    loopFrame = requestAnimationFrame(tick);
  };
  const startLoop = () => {
    if (loopFrame === null && !disposed) {
      loopFrame = requestAnimationFrame(tick);
    }
  };
  const handleInteractionStart = () => {
    interacting = true;
    startLoop();
  };
  const handleInteractionEnd = () => {
    interacting = false;
  };
  controls.addEventListener("start", handleInteractionStart);
  controls.addEventListener("end", handleInteractionEnd);

  // 循环负责渲染时不再叠加单帧请求，避免重复渲染。
  const handleControlsChange = () => {
    if (loopFrame === null) {
      redraw();
    }
  };
  controls.addEventListener("change", handleControlsChange);

  const handleContextLost = (event: Event) => {
    event.preventDefault();
    for (const frame of [pendingFrame, loopFrame]) {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    }
    pendingFrame = null;
    loopFrame = null;
    onContextLost();
  };
  canvas.addEventListener("webglcontextlost", handleContextLost);

  const resizeObserver =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => resize());
  resizeObserver?.observe(canvas);
  resize();

  return {
    setModel(object: Object3D): ModelPreviewStats {
      if (content) {
        scene.remove(content);
        disposeObject3D(content);
      }
      content = object;
      scene.add(object);

      const box = new Box3().setFromObject(object);
      if (box.isEmpty()) {
        // 空模型：不设取景，交给调用方按"没有可渲染几何"处理。
        fit = null;
        draw();
        return { triangles: 0, size: { x: 0, y: 0, z: 0 } };
      }

      const sphere = box.getBoundingSphere(new Sphere());
      fit = { center: sphere.center.clone(), radius: Math.max(sphere.radius, 0.01) };
      const size = box.getSize(new Vector3());

      // 地面网格按模型尺度重建：小到看不见、大到出画都失去参照意义。
      scene.remove(grid);
      grid.geometry.dispose();
      grid.material.dispose();
      grid = new GridHelper(
        Math.max(size.x, size.y, size.z, 0.001) * 2.4,
        20,
        new Color(colors.center),
        new Color(colors.grid),
      );
      grid.material.transparent = true;
      grid.material.opacity = 0.45;
      grid.material.depthWrite = false;
      grid.position.set(fit.center.x, box.min.y, fit.center.z);
      scene.add(grid);
      applyFit();
      draw();

      let triangles = 0;
      object.traverse((child) => {
        const geometry = (
          child as {
            geometry?: {
              index?: { count: number } | null;
              attributes?: Record<string, { count?: number }>;
            };
          }
        ).geometry;
        const position = geometry?.attributes?.position;
        if (position) {
          triangles += Math.floor((geometry?.index?.count ?? position.count ?? 0) / 3);
        }
      });
      return { triangles, size: { x: size.x, y: size.y, z: size.z } };
    },

    resetView() {
      applyFit();
      draw();
    },

    redraw,

    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const frame of [pendingFrame, loopFrame]) {
        if (frame !== null) {
          cancelAnimationFrame(frame);
        }
      }
      pendingFrame = null;
      loopFrame = null;
      resizeObserver?.disconnect();
      controls.removeEventListener("change", handleControlsChange);
      controls.removeEventListener("start", handleInteractionStart);
      controls.removeEventListener("end", handleInteractionEnd);
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      controls.dispose();
      if (content) {
        scene.remove(content);
        disposeObject3D(content);
        content = null;
      }
      grid.geometry.dispose();
      grid.material.dispose();
      scene.environment = null;
      environment.dispose();
      pmrem.dispose();
      scene.clear();
      renderer.dispose();
      // 显式丢弃上下文：连开几个模型时不这么做会撞上浏览器的 WebGL 上下文上限。
      renderer.forceContextLoss();
    },
  };
}
