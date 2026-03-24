# Kosca AR System

Welcome to the Kosca Accounts Receivable System! This is a modern Node.js web application designed to help you easily upload Excel reports containing your Accounts Receivable data, parse that data in the background, and view it in a clean, searchable dashboard.

## Features
- **Excel Uploads**: Easily drag and drop or select your `.xlsx` files.
- **Background Processing**: Uploads are quickly processed in the background using BullMQ and Redis, keeping the application fast and responsive.
- **Modern Dashboard**: A clean, professional interface built with Tailwind CSS.
- **Dynamic Table**: Search, filter, and page through your invoices quickly with the power of HTMX and Alpine.js.

## Prerequisites
To run this application, you only need one piece of software installed on your machine:
- **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** (for Windows/Mac) or Docker Engine & Docker Compose (for Linux).

No Node.js, Postgres, or Redis installation is required! Docker handles everything for you.

---

## 🚀 Getting Started

Follow these simple steps to get the application running on your computer.

### Quick Start (Development Mode)

Development mode runs the application with "live reload." If you modify the code, the server will automatically restart and apply your changes.

**1. Open your terminal** and navigate to the folder containing this project (`kosca_ar_system`).

**2. Start the services using Docker Compose:**
```bash
docker compose up --build
```
> **Tip:** Adding `-d` (`docker compose up -d --build`) will run the application in the background so you can continue using your terminal.

**3. Wait a moment!** Docker will download the necessary pieces (Postgres, Redis, Node.js) and start up your app. It might take a minute or two the first time.

**4. Access the Application!**
Open your web browser and navigate to: [http://localhost:3000](http://localhost:3000)

---

### Production Mode

Production mode runs the application optimized for speed and performance. 

**1. Open your terminal** in the `kosca_ar_system` folder.

**2. Set the environment variable to production and start Docker Compose:**

**On Mac/Linux:**
```bash
DOCKER_TARGET=prod NPM_SCRIPT=start docker compose up -d --build
```

**On Windows (PowerShell):**
```powershell
$env:DOCKER_TARGET="prod"; $env:NPM_SCRIPT="start"; docker compose up -d --build
```

**3. Access the Application** at [http://localhost:3000](http://localhost:3000)

---

## 🛑 How to Stop the Application

When you are done using the application, you can shut it down gracefully so it doesn't consume your computer's memory.

1. If it's running in your current terminal, simply press `Ctrl + C`.
2. To fully stop the containers and free up resources, run:
```bash
docker compose down
```

*Note: Your database data is saved safely in a Docker volume, so you won't lose your invoices when you shut down!*

## File Requirements
When uploading an Excel file (`.xlsx`), ensure the file has a header row with the following columns (names can have slight variations like "Invoice Date" vs "Date"):
- **Customer Name**
- **Invoice Date**
- **Due Date**
- **Balance Amount** 
- **Aging (Days)**
