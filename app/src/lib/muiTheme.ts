// MUI 主题 —— 对齐 theme.css 设计 token：黑 · 低饱和紫 · 零圆角
import { createTheme } from "@mui/material/styles";

export const muiTheme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#6d5da5", light: "#a89cf0", dark: "#5c4e8d", contrastText: "#f2f0f8" },
    background: { default: "#0d0b11", paper: "#1b1921" },
    text: { primary: "#ece8f2", secondary: "#8d8498", disabled: "#605870" },
    divider: "#2a2731",
    success: { main: "#35c37c" },
    warning: { main: "#e5b04e" },
    error: { main: "#e05a4f" },
  },
  shape: { borderRadius: 0 },
  typography: {
    fontFamily: '"PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", system-ui, sans-serif',
    fontSize: 13,
  },
  components: {
    MuiSelect: {
      defaultProps: { size: "small" },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          boxSizing: "border-box",
          backgroundColor: "#1b1921",
          fontSize: 13,
          height: "var(--ctrl-h)",
          borderRadius: 0,
          transition: "background 140ms cubic-bezier(0.2,0.7,0.3,1), box-shadow 140ms cubic-bezier(0.2,0.7,0.3,1)",
          "& .MuiOutlinedInput-notchedOutline": {
            borderColor: "#3d3946",
            transition: "border-color 140ms cubic-bezier(0.2,0.7,0.3,1), box-shadow 140ms cubic-bezier(0.2,0.7,0.3,1)",
          },
          "&:hover:not(.Mui-focused) .MuiOutlinedInput-notchedOutline": { borderColor: "#605870" },
          "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
            borderColor: "var(--ctrl-focus-border, #6d5da5)",
            borderWidth: 1,
            boxShadow: "none",
          },
          "&.Mui-focused": {
            backgroundColor: "var(--ctrl-focus-bg, #15131a)",
            boxShadow: "var(--ctrl-focus-shadow, 0 0 12px -2px rgba(109, 93, 165, 0.4))",
            outline: "none",
          },
          "& .MuiSelect-select:focus-visible": { outline: "none" },
          "&.Mui-disabled": { backgroundColor: "#15131a" },
          "&.Mui-disabled .MuiOutlinedInput-notchedOutline": { borderColor: "#2a2731" },
          // 选中文本区：与按钮同高（--ctrl-h）并垂直居中，避免高度错位
          "& .MuiSelect-select": {
            boxSizing: "border-box",
            height: "var(--ctrl-h)",
            minWidth: 0,
            lineHeight: "calc(var(--ctrl-h) - 2px)",
            overflow: "hidden",
            paddingTop: 0,
            paddingBottom: 0,
            paddingRight: 32,
            display: "flex",
            alignItems: "center",
          },
        },
        input: {
          boxSizing: "border-box",
          padding: "0 10px",
          height: "var(--ctrl-h)",
          minHeight: 0,
          display: "flex",
          alignItems: "center",
        },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          backgroundColor: "#1b1921",
          backgroundImage: "none",
          border: "1px solid #3d3946",
          borderRadius: 0,
          boxShadow: "0 16px 44px -12px rgba(0, 0, 0, 0.85)",
          marginTop: 2,
          transition: "border-color 140ms cubic-bezier(0.2,0.7,0.3,1), box-shadow 140ms cubic-bezier(0.2,0.7,0.3,1)",
          "&:hover": { borderColor: "#605870" },
        },
        list: { padding: "3px 0" },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          fontSize: 13,
          minHeight: 30,
          padding: "5px 12px",
          borderLeft: "2px solid transparent",
          paddingLeft: 10,
          color: "#c6bfd1",
          transition: "background 140ms cubic-bezier(0.2,0.7,0.3,1), color 140ms cubic-bezier(0.2,0.7,0.3,1), border-color 140ms cubic-bezier(0.2,0.7,0.3,1), box-shadow 140ms cubic-bezier(0.2,0.7,0.3,1)",
          "&:hover": {
            backgroundColor: "#232029",
            color: "#ece8f2",
            borderColor: "#605870",
            boxShadow: "inset 0 0 0 1px #605870",
          },
          "&.Mui-selected": {
            backgroundColor: "rgba(109, 93, 165, 0.16)",
            color: "#a89ccf",
            borderLeft: "2px solid #6d5da5",
          },
          "&.Mui-selected:hover": { backgroundColor: "rgba(109, 93, 165, 0.24)" },
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: "#232029",
          border: "1px solid #3d3946",
          borderRadius: 0,
          fontSize: 12,
        },
      },
    },
  },
});
