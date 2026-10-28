// Studio theme. Every value points at a CSS variable from styles.css, so Studio, its grids and
// charts, and our custom widgets all read as one page.
import { studioTheme } from "ag-studio";

const token = (name: string) => `var(--dc-${name})`;
const line = (color: string) => ({ width: 1, color: token(color) });

const palette = Object.fromEntries(
  Array.from({ length: 6 }, (_, i) => [
    [`chartPaletteFills${i + 1}Color`, token(`chart-${i + 1}`)],
    [`chartPaletteStrokes${i + 1}Color`, token(`chart-${i + 1}`)],
  ]).flat(),
);

export const disputeTheme = studioTheme.withParams({
  fontFamily: token("font"),
  fontSize: 14,
  textColor: token("ink"),
  foregroundColor: token("ink"),
  subtleTextColor: token("muted"),
  backgroundColor: token("surface"),
  borderColor: token("border"),
  accentColor: token("accent"),
  iconColor: token("ink"),
  rowHoverColor: token("highlight"),

  studioWrapperBorder: false,
  studioWrapperBorderRadius: 0,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: "transparent",
  studioCanvasBorder: false,
  studioCanvasBorderRadius: 0,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: "transparent",
  studioCanvasPadding: 24,
  studioCanvasRowHeight: 20,
  studioCanvasFontFamily: token("font"),

  studioWidgetBackgroundColor: token("surface"),
  studioWidgetBorder: false,
  studioWidgetBorderRadius: 16,
  studioWidgetPadding: 20,
  studioWidgetTitleFontFamily: token("font"),
  studioWidgetTitleFontSize: 14,
  studioWidgetTitleFontWeight: 600,
  studioWidgetTitleTextColor: token("muted"),
  studioWidgetSubtitleFontFamily: token("font"),
  studioWidgetSubtitleFontSize: 13,
  studioWidgetSubtitleTextColor: token("muted"),
  studioWidgetCaptionFontFamily: token("font"),
  studioWidgetCaptionFontSize: 13,
  studioWidgetCaptionTextColor: token("muted"),
  studioWidgetResizeBorderColor: token("accent"),

  studioPanelContainerBackgroundColor: token("surface"),
  studioPanelContainerBorder: line("border"),
  studioPanelContainerBorderRadius: 0,
  studioPanelDividerColor: token("border"),
  studioPanelDividerActiveColor: token("accent"),
  studioPanelSectionBorderColor: token("border"),
  studioPanelHeaderFontFamily: token("font"),
  studioPanelHeaderFontWeight: 600,

  gridFontFamily: token("font"),
  gridFontSize: 14,
  gridCellTextColor: token("ink"),
  gridHeaderBackgroundColor: token("surface"),
  gridHeaderTextColor: token("muted"),
  gridHeaderFontWeight: 600,
  gridHeaderFontSize: 13,
  gridRowHeight: 38,
  gridRowBorder: line("gridline"),
  gridHeaderRowBorder: line("border"),
  gridRowHoverColor: token("highlight"),
  gridWrapperBorder: false,

  chartFontFamily: token("font"),
  chartTextColor: token("ink"),
  chartSubtleTextColor: token("muted"),
  chartAxisLineColor: token("border"),
  chartGridLineColor: token("gridline"),
  ...palette,
});
