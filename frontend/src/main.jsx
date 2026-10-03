import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <main className="crash">
          <h1>ToolGuard gặp lỗi khi vẽ trang</h1>
          <p>{this.state.error.message}</p>
        </main>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <Boundary>
    <App />
  </Boundary>
);
