import type { OutputTableCellSnapshot, OutputTableSnapshot } from "./output-table-snapshot.ts";

const MAX_IMAGE_EDGE = 32_000;
const MAX_IMAGE_PIXELS = 64_000_000;
const MIN_IMAGE_SCALE = 0.25;

function isTransparent(color: string): boolean {
  return color === "transparent" || /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(color);
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fittedText(context: CanvasRenderingContext2D, value: string, width: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (width <= 0 || context.measureText(text).width <= width) return text;

  const characters = Array.from(text);
  const ellipsis = "…";
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (context.measureText(`${characters.slice(0, middle).join("")}${ellipsis}`).width <= width) low = middle;
    else high = middle - 1;
  }
  return low > 0 ? `${characters.slice(0, low).join("")}${ellipsis}` : ellipsis;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取表格中的速度图像"));
    image.src = dataUrl;
  });
}

async function loadSparklineImages(snapshot: OutputTableSnapshot): Promise<Map<string, HTMLImageElement>> {
  const dataUrls = new Set<string>();
  for (const row of [snapshot.headers, ...snapshot.rows, ...(snapshot.footer ? [snapshot.footer] : [])]) {
    for (const cell of row) {
      if (cell.sparklineDataUrl) dataUrls.add(cell.sparklineDataUrl);
    }
  }

  const loaded = await Promise.all(Array.from(dataUrls, async dataUrl => [dataUrl, await loadImage(dataUrl)] as const));
  return new Map(loaded);
}

function drawCell(
  context: CanvasRenderingContext2D,
  cell: OutputTableCellSnapshot,
  image: HTMLImageElement | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const { style } = cell;
  if (!isTransparent(style.backgroundColor)) {
    context.fillStyle = style.backgroundColor;
    context.fillRect(x, y, width, height);
  }

  const paddingLeft = cssPixels(style.padding.left);
  const paddingRight = cssPixels(style.padding.right);
  const paddingTop = cssPixels(style.padding.top);
  const paddingBottom = cssPixels(style.padding.bottom);
  const contentWidth = Math.max(0, width - paddingLeft - paddingRight);
  const contentHeight = Math.max(0, height - paddingTop - paddingBottom);

  if (image) {
    const imageHeight = Math.min(contentHeight, image.naturalHeight / 2 || contentHeight);
    context.drawImage(
      image,
      x + paddingLeft,
      y + paddingTop + (contentHeight - imageHeight) / 2,
      contentWidth,
      imageHeight,
    );
  } else if (cell.text) {
    const fontSize = cssPixels(style.textFontSize ?? style.fontSize) || 16;
    const fontFamily = style.textFontFamily ?? style.fontFamily;
    const fontWeight = style.textFontWeight ?? style.fontWeight;
    const fontStyle = style.textFontStyle ?? style.fontStyle;
    context.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
    context.fillStyle = style.textColor ?? style.color;
    context.textBaseline = "middle";
    context.textAlign = style.textAlign === "right" || style.textAlign === "end"
      ? "right"
      : style.textAlign === "center" ? "center" : "left";

    const text = fittedText(context, cell.text, contentWidth);
    const textX = context.textAlign === "center"
      ? x + paddingLeft + contentWidth / 2
      : context.textAlign === "right" ? x + width - paddingRight : x + paddingLeft;
    const textY = y + paddingTop + contentHeight / 2;
    context.fillText(text, textX, textY);
  }

  for (const side of ["top", "right", "bottom", "left"] as const) {
    const border = style.borders[side];
    const borderWidth = cssPixels(border.width);
    if (border.style === "none" || borderWidth <= 0 || isTransparent(border.color)) continue;
    context.fillStyle = border.color;
    if (side === "top") context.fillRect(x, y, width, borderWidth);
    else if (side === "right") context.fillRect(x + width - borderWidth, y, borderWidth, height);
    else if (side === "bottom") context.fillRect(x, y + height - borderWidth, width, borderWidth);
    else context.fillRect(x, y, borderWidth, height);
  }
}

export async function renderOutputTablePng(snapshot: OutputTableSnapshot): Promise<Uint8Array> {
  const rows = [snapshot.headers, ...snapshot.rows, ...(snapshot.footer ? [snapshot.footer] : [])];
  const naturalWidth = snapshot.columnWidthsPx.reduce((total, width) => total + width, 0);
  const rowHeights = [snapshot.headerHeightPx, ...snapshot.rowHeightsPx, ...(snapshot.footer ? [snapshot.footerHeightPx || 30] : [])];
  const naturalHeight = rowHeights.reduce((total, height) => total + height, 0);
  if (naturalWidth <= 0 || naturalHeight <= 0) throw new Error("表格尺寸无效，无法生成 PNG 图片");

  const scale = Math.min(
    2,
    MAX_IMAGE_EDGE / naturalWidth,
    MAX_IMAGE_EDGE / naturalHeight,
    Math.sqrt(MAX_IMAGE_PIXELS / (naturalWidth * naturalHeight)),
  );
  if (scale < MIN_IMAGE_SCALE) throw new Error("表格尺寸过大，请先筛选部分节点后再保存为 PNG");

  const width = Math.ceil(naturalWidth * scale);
  const height = Math.ceil(naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建 PNG 图片");
  context.scale(scale, scale);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, naturalWidth, naturalHeight);

  const images = await loadSparklineImages(snapshot);
  let y = 0;
  rows.forEach((row, rowIndex) => {
    const rowHeight = rowHeights[rowIndex] ?? 40;
    let x = 0;
    row.forEach((cell, columnIndex) => {
      const columnWidth = snapshot.columnWidthsPx[columnIndex] ?? 100;
      drawCell(context, cell, cell.sparklineDataUrl ? images.get(cell.sparklineDataUrl) : undefined, x, y, columnWidth, rowHeight);
      x += columnWidth;
    });
    y += rowHeight;
  });

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error("生成 PNG 图片失败")), "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}
