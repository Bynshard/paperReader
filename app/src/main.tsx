import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: {
  staleTime: 30_000, gcTime: 60_000, retry: 1, refetchOnWindowFocus: false,
} } });

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}><App /></QueryClientProvider>
  </React.StrictMode>,
);
