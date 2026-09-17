# Pacdora Clone - Frontend/Backend Split

> **Running locally (Windows):** double-click `run.bat` (uses the SQLite file `frontend/dev.db`).
> **Deploying to Render (PostgreSQL):** see [DEPLOY_RENDER.md](DEPLOY_RENDER.md) and `render.yaml`.

This project has been organized into separate frontend and backend directories for better organization.

## Project Structure

```
pacdora-clone/
├── backend/              # Backend utilities and model generation
│   ├── generate_primitives.js  # Generates basic 3D models (box, cylinder, standup pouch)
│   └── generate_pouch.js       # Generates pillow pouch models
├── frontend/             # Frontend Next.js application
│   ├── public/           # Static assets including 3D models
│   │   └── models/       # OBJ files for 3D models
│   ├── src/              # Source code
│   │   ├── app/          # Next.js app router
│   │   ├── components/   # React components
│   │   ├── lib/          # Utility libraries
│   │   └── store/        # State management (Zustand)
│   ├── next.config.mjs   # Next.js configuration
│   ├── tsconfig.json     # TypeScript configuration
│   └── ...               # Other frontend config files
├── node_modules/         # Dependencies
├── package.json          # Project dependencies and scripts
├── package-lock.json     # Dependency lock file
└── README.md             # This file
```

## Getting Started

### Frontend Development

First, navigate to the frontend directory and run the development server:

```bash
cd frontend
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `frontend/src/app/page.tsx`. The page auto-updates as you edit the file.

### Backend Utilities

The backend directory contains utility scripts for generating 3D models:

```bash
cd backend
node generate_primitives.js  # Generate box, cylinder, and standup pouch models
node generate_pouch.js       # Generate pillow pouch model
```

These scripts write their output to `frontend/public/models/` to be used by the frontend application.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js/) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/deployment) for more details.
