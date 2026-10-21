/**
 * 插图片：量出图片真实尺寸 → 按版心等比缩放 → 交给引擎。
 *
 * 为什么要异步量：`new Image()` 的宽高只有 onload 之后才有效，而引擎的 `executeImage` 只认现成宽高。
 * 量不出来（加载失败/跨域）就退回保守尺寸，不阻塞插入。
 */
/**
 * 插图片：量出图片真实尺寸 → 按版心（纸张宽 − 左右页边距）等比缩放 → 交给引擎。
 *
 * 为什么要异步量：`new Image()` 的宽高只有在 onload 之后才有效；引擎的 executeImage 只认现成的宽高。
 * 量不出来（网络图片跨域/加载失败）就退回一个保守尺寸，不阻塞插入。
 */
export async function insertImageWithNaturalSize(
  commands: Record<string, unknown>,
  status: (message: string) => void,
  value: string,
): Promise<void> {
  const options = (
    commands.getOptions as (() => { width?: number; margins?: number[] }) | undefined
  )?.();
  const width = options?.width ?? 794;
  const margins = options?.margins ?? [100, 120, 100, 120];
  const innerWidth = Math.max(120, width - (margins[1] ?? 0) - (margins[3] ?? 0));
  try {
    const size = await loadImageSize(value);
    const ratio = Math.min(1, innerWidth / size.width);
    const target = {
      width: Math.round(size.width * ratio),
      height: Math.round(size.height * ratio),
    };
    (commands.executeImage as ((payload: Record<string, unknown>) => void) | undefined)?.({
      value,
      ...target,
    });
    status(`已插入图片（${target.width}×${target.height}，原图 ${size.width}×${size.height}）`);
  } catch {
    (commands.executeImage as ((payload: Record<string, unknown>) => void) | undefined)?.({
      value,
      width: Math.round(innerWidth / 2),
      height: Math.round(innerWidth / 3),
    });
    status("已插入图片（读不到原始尺寸，用了默认大小，可在文档里拖拽调整）");
  }
}

function loadImageSize(value: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("image load failed"));
    image.src = value;
  });
}
