#!/usr/bin/env bun

// Compatibility entry point. The public command remains `seat`; the CLI is
// implemented separately so the seat, thread, and task domains stay focused.
import "./cli";
