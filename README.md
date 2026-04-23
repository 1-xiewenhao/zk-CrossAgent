# zk-CrossAgent

Prototype implementation of **zk-CrossAgent**, a task-bounded cross-chain settlement protocol for autonomous AI agents.

## Overview

zk-CrossAgent is a prototype system for secure cross-domain service procurement by autonomous AI agents.  
It combines:

- **task-bounded capability delegation**
- **nested dual-signature receipts**
- **asynchronous batch ZKP verification**
- **cross-chain settlement with main-chain escrow**

The prototype is designed to demonstrate that task-level budget control, dual confirmation, and non-blocking online interaction can coexist in a practical agent system.

## Repository Structure

```text
.
├── benchmark_payloads/      # Fixed request bodies for gateway load testing
├── circuits/                # Circom circuits and related proving assets
├── contracts/               # Solidity smart contracts
├── ignition/                # Hardhat ignition deployment modules
├── scripts/                 # Main runtime, deployment, and benchmark scripts
├── .env.example             # Environment variable template
├── .gitignore
├── README.md
├── deploy.js
├── hardhat.config.js
├── package.json
└── package-lock.json
