export interface OutputTableCellSnapshot {
  text: string;
  note?: string;
  sparklineDataUrl?: string;
  style: OutputTableCellStyleSnapshot;
}

export interface OutputTableCellStyleSnapshot {
  color: string;
  backgroundColor: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  fontStyle: string;
  textAlign: string;
  verticalAlign: string;
  padding: Record<"top" | "right" | "bottom" | "left", string>;
  textColor?: string;
  textFontFamily?: string;
  textFontSize?: string;
  textFontWeight?: string;
  textFontStyle?: string;
  borders: Record<"top" | "right" | "bottom" | "left", {
    color: string;
    style: string;
    width: string;
  }>;
}

export interface OutputTableSnapshot {
  headers: OutputTableCellSnapshot[];
  rows: OutputTableCellSnapshot[][];
  footer: OutputTableCellSnapshot[] | null;
  columnWidthsPx: number[];
  headerHeightPx: number;
  rowHeightsPx: number[];
  footerHeightPx: number;
}

function captureCellStyle(cell: HTMLTableCellElement): OutputTableCellStyleSnapshot {
  const style = getComputedStyle(cell);
  const primaryText = cell.querySelector<HTMLElement>(".output-table-primary");
  const primaryTextStyle = primaryText ? getComputedStyle(primaryText) : undefined;
  return {
    color: style.color,
    backgroundColor: style.backgroundColor,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    textAlign: style.textAlign,
    verticalAlign: style.verticalAlign,
    padding: {
      top: style.paddingTop,
      right: style.paddingRight,
      bottom: style.paddingBottom,
      left: style.paddingLeft,
    },
    ...(primaryTextStyle ? {
      textColor: primaryTextStyle.color,
      textFontFamily: primaryTextStyle.fontFamily,
      textFontSize: primaryTextStyle.fontSize,
      textFontWeight: primaryTextStyle.fontWeight,
      textFontStyle: primaryTextStyle.fontStyle,
    } : {}),
    borders: {
      top: { color: style.borderTopColor, style: style.borderTopStyle, width: style.borderTopWidth },
      right: { color: style.borderRightColor, style: style.borderRightStyle, width: style.borderRightWidth },
      bottom: { color: style.borderBottomColor, style: style.borderBottomStyle, width: style.borderBottomWidth },
      left: { color: style.borderLeftColor, style: style.borderLeftStyle, width: style.borderLeftWidth },
    },
  };
}

function captureSparkline(cell: HTMLTableCellElement): string | undefined {
  const chart = cell.querySelector<HTMLElement>(".speed-sparkline");
  if (!chart) return undefined;

  const chartBounds = chart.getBoundingClientRect();
  if (chartBounds.width <= 0 || chartBounds.height <= 0) return undefined;

  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(chartBounds.width * scale);
  canvas.height = Math.ceil(chartBounds.height * scale);
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.scale(scale, scale);

  for (const bar of chart.querySelectorAll<HTMLElement>(".speed-sparkline-bar")) {
    const bounds = bar.getBoundingClientRect();
    const barStyle = getComputedStyle(bar);
    context.fillStyle = barStyle.backgroundColor;
    context.fillRect(
      bounds.left - chartBounds.left,
      bounds.top - chartBounds.top,
      bounds.width,
      bounds.height,
    );
  }

  const chartStyle = getComputedStyle(chart);
  const borderWidth = Number.parseFloat(chartStyle.borderBottomWidth);
  if (borderWidth > 0 && chartStyle.borderBottomStyle !== "none") {
    context.fillStyle = chartStyle.borderBottomColor;
    context.fillRect(0, chartBounds.height - borderWidth, chartBounds.width, borderWidth);
  }

  return canvas.toDataURL("image/png");
}

function captureCell(cell: HTMLTableCellElement): OutputTableCellSnapshot {
  const isSparklineCell = cell.classList.contains("output-table-spark-cell");
  const sparklineDataUrl = isSparklineCell
    ? captureSparkline(cell)
    : undefined;
  const visibleText = cell.innerText.trim();
  return {
    text: sparklineDataUrl ? "" : visibleText || (isSparklineCell ? cell.title : ""),
    note: sparklineDataUrl ? cell.title || undefined : undefined,
    sparklineDataUrl,
    style: captureCellStyle(cell),
  };
}

function visibleCells(row: HTMLTableRowElement): HTMLTableCellElement[] {
  return Array.from(row.cells).filter(cell => !cell.classList.contains("output-table-filler"));
}

function rowHeight(row: HTMLTableRowElement): number {
  return row.getBoundingClientRect().height;
}

export function captureOutputTableSnapshot(table: HTMLTableElement): OutputTableSnapshot | null {
  const headerRow = table.tHead?.rows[0];
  if (!headerRow) return null;

  const headerCells = visibleCells(headerRow);
  if (headerCells.length === 0) return null;

  const dataRows = Array.from(table.tBodies)
    .flatMap(body => Array.from(body.rows))
    .filter(row => !row.classList.contains("output-table-virtual-spacer"));
  const footerRow = table.tFoot?.rows[0] ?? null;
  const columns = Array.from(table.querySelectorAll<HTMLTableColElement>("col[data-column-key]"));

  return {
    headers: headerCells.map(captureCell),
    rows: dataRows.map(row => visibleCells(row).map(captureCell)),
    footer: footerRow ? visibleCells(footerRow).map(captureCell) : null,
    columnWidthsPx: columns.slice(0, headerCells.length).map(column => {
      const width = column.getBoundingClientRect().width || Number.parseFloat(column.style.width);
      return Number.isFinite(width) && width > 0 ? width : 100;
    }),
    headerHeightPx: rowHeight(headerRow),
    rowHeightsPx: dataRows.map(rowHeight),
    footerHeightPx: footerRow ? rowHeight(footerRow) : 0,
  };
}
