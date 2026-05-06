import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {};

// withWorkflow enables the Workflow DevKit compiler — required so the
// `"use workflow"` and `"use step"` directives in src/workflows/*.ts
// produce durable, checkpointed runs instead of plain async functions.
export default withWorkflow(nextConfig);
