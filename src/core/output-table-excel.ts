import { Workbook } from "exceljs";
import type { Border, BorderStyle, Borders, Cell as ExcelCell } from "exceljs";
import type { OutputTableCellSnapshot, OutputTableSnapshot } from "./output-table-snapshot.ts";

function cssColorToArgb(value: string): string | undefined {
  const rgb = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : Number.parseFloat(rgb[4]);
    if (alpha <= 0) return undefined;
    const channel = (part: string) => Number.parseInt(part, 10).toString(16).padStart(2, "0").toUpperCase();
    return `${Math.round(alpha * 255).toString(16).padStart(2, "0").toUpperCase()}${channel(rgb[1]!)}${channel(rgb[2]!)}${channel(rgb[3]!)}`;
  }

  const hex = value.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if (!hex) return undefined;
  const expanded = hex.length === 3 ? [...hex].map(part => `${part}${part}`).join("") : hex;
  return `FF${expanded.toUpperCase()}`;
}

function excelBorderStyle(style: string): BorderStyle {
  if (style === "double") return "double";
  if (style === "dashed") return "dashed";
  if (style === "dotted") return "dotted";
  return "thin";
}

function excelBorderSide(cell: OutputTableCellSnapshot, side: "top" | "right" | "bottom" | "left"): Border | undefined {
  const border = cell.style.borders[side];
  if (border.style === "none" || Number.parseFloat(border.width) <= 0) return undefined;
  const color = cssColorToArgb(border.color);
  const result: Border = { style: excelBorderStyle(border.style), color: {} };
  if (color) result.color.argb = color;
  return result;
}

function applyCellStyle(target: ExcelCell, source: OutputTableCellSnapshot): void {
  const color = cssColorToArgb(source.style.color);
  const fillColor = cssColorToArgb(source.style.backgroundColor);
  const cssFontSize = Number.parseFloat(source.style.fontSize);
  target.font = {
    name: "Segoe UI",
    size: Number.isFinite(cssFontSize) ? Math.max(8, Math.round(cssFontSize * 0.75)) : 10,
    bold: Number.parseInt(source.style.fontWeight, 10) >= 600,
    ...(color ? { color: { argb: color } } : {}),
  };
  target.alignment = {
    horizontal: source.style.textAlign === "left" || source.style.textAlign === "start"
      ? "left"
      : source.style.textAlign === "right" || source.style.textAlign === "end" ? "right" : "center",
    vertical: "middle",
    shrinkToFit: true,
    wrapText: false,
  };
  if (fillColor) {
    target.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
  }

  const border: Partial<Borders> = {};
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const value = excelBorderSide(source, side);
    if (value) border[side] = value;
  }
  target.border = border;
}

function addRow(
  worksheet: ReturnType<Workbook["addWorksheet"]>,
  sources: OutputTableCellSnapshot[],
  heightPx: number,
  rowIndex: number,
  imageCells: Array<{ row: number; column: number; dataUrl: string }>,
): void {
  const row = worksheet.addRow(sources.map(source => source.text));
  row.height = Math.max(16, heightPx * 0.75);
  sources.forEach((source, columnIndex) => {
    const cell = row.getCell(columnIndex + 1);
    applyCellStyle(cell, source);
    if (source.note) cell.note = source.note;
    if (source.sparklineDataUrl) imageCells.push({ row: rowIndex, column: columnIndex, dataUrl: source.sparklineDataUrl });
  });
}

export async function writeOutputTableWorkbook(snapshot: OutputTableSnapshot): Promise<Uint8Array> {
  const workbook = new Workbook();
  workbook.creator = "all2uri";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("节点结果", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
  });
  worksheet.properties.defaultRowHeight = 30;
  worksheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 9,
  };
  worksheet.columns = snapshot.columnWidthsPx.map(width => ({ width: Math.max(5, width / 7) }));

  const imageCells: Array<{ row: number; column: number; dataUrl: string }> = [];
  addRow(worksheet, snapshot.headers, snapshot.headerHeightPx, 0, imageCells);
  snapshot.rows.forEach((row, index) => {
    addRow(worksheet, row, snapshot.rowHeightsPx[index] ?? 40, index + 1, imageCells);
  });
  if (snapshot.footer) {
    addRow(
      worksheet,
      snapshot.footer,
      snapshot.footerHeightPx || 30,
      snapshot.rows.length + 1,
      imageCells,
    );
  }

  if (snapshot.rows.length > 0 && snapshot.headers.length > 0) {
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: snapshot.rows.length + 1, column: snapshot.headers.length },
    };
  }

  for (const image of imageCells) {
    const imageId = workbook.addImage({ base64: image.dataUrl, extension: "png" });
    const rowHeightPx = snapshot.rowHeightsPx[image.row - 1] ?? 40;
    const columnWidthPx = snapshot.columnWidthsPx[image.column] ?? 100;
    worksheet.addImage(imageId, {
      tl: { col: image.column + 0.05, row: image.row + 0.17 },
      ext: {
        width: Math.max(24, columnWidthPx - 12),
        height: Math.max(12, rowHeightPx * 0.65),
      },
    });
  }

  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
