import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "WAKEMON — lofi radio",
    short_name: "WAKEMON",
    description: "A cozy lofi-styled walkman music player UI.",
    start_url: "/",
    display: "standalone",
    background_color: "#12100c",
    theme_color: "#12100c",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}