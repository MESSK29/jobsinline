const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const xlsx = require("xlsx");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const port = process.env.PORT || 3000;
const JOB_ROLES_FILE = path.join(__dirname, "jobrolespskillsframeworks.xlsx");

// MongoDB connection
mongoose.connect("mongodb+srv://messk29:Saibaba12@messk29.nvpwpfw.mongodb.net/?retryWrites=true&w=majority&appName=MESSK29", {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log("Connected to MongoDB"))
  .catch(err => console.error("MongoDB connection error:", err));

// User schema and model
const UserSchema = new mongoose.Schema({
    Username: { type: String, required: true, unique: true },
    Email: { type: String, required: true },
    Phone: { type: String, required: true },
    Password: { type: String, required: true }
});
const User = mongoose.model("User", UserSchema);

// Google Generative AI setup
const apiKey = "AIzaSyCCHFgeeK7ToNo4nQ6PivPsJB4IakqHxj4";
const genAI = new GoogleGenerativeAI(apiKey);

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Excel file handling with fallback
function readExcelData(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            console.log(`File ${filePath} not found, initializing empty array`);
            return [];
        }
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(worksheet);
        console.log(`Loaded ${data.length} job roles from ${filePath}`);
        return data;
    } catch (error) {
        console.error(`Error reading Excel file ${filePath}:`, error);
        return [];
    }
}

function saveExcelData(filePath, data) {
    try {
        if (!data || !Array.isArray(data)) {
            throw new Error("Invalid data format for saving to Excel");
        }
        const worksheet = xlsx.utils.json_to_sheet(data);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, "Sheet1");
        fs.writeFileSync(filePath, xlsx.write(workbook, { bookType: "xlsx", type: "buffer" }));
        console.log(`Successfully saved ${data.length} job roles to ${filePath}`);
        return true;
    } catch (error) {
        console.error(`Error saving Excel file ${filePath}:`, error);
        return false;
    }
}

function loadJobRoles() {
    return readExcelData(JOB_ROLES_FILE);
}

// MongoDB user handling (unchanged)
async function saveUsers(users) {
    try {
        await User.insertMany(users, { ordered: false });
        console.log("Users saved to MongoDB");
    } catch (error) {
        console.error("Error saving users to MongoDB:", error);
        throw error;
    }
}

async function loadUsers() {
    try {
        return await User.find();
    } catch (error) {
        console.error("Error loading users from MongoDB:", error);
        return [];
    }
}

// Authentication endpoint (unchanged)
app.post("/auth", async (req, res) => {
    const { action, username, password, email, phone } = req.body;
    try {
        if (action === "login") {
            const users = await loadUsers();
            const user = users.find((u) => u.Username === username);
            if (!user) {
                return res.status(404).json({ success: false, message: "No username found! Please register.", redirect: "register" });
            }
            if (user.Password !== password) {
                return res.status(401).json({ success: false, message: "Incorrect password!" });
            }
            res.status(200).json({ success: true, message: "Login successful!", redirect: "main", username });
        } else if (action === "register") {
            const users = await loadUsers();
            if (users.some((u) => u.Username === username)) {
                return res.status(400).json({ success: false, message: "Username already exists!" });
            }
            if (!phone || phone.trim() === "") {
                return res.status(400).json({ success: false, message: "Phone number is required!" });
            }
            const newUser = { Username: username, Email: email, Phone: phone, Password: password };
            await saveUsers([newUser]);
            res.status(201).json({ success: true, message: "Registration successful! You can now log in." });
        } else {
            res.status(400).json({ success: false, message: "Invalid action" });
        }
    } catch (error) {
        console.error("Error in /auth endpoint:", error);
        res.status(500).json({ success: false, message: "Server error during authentication", error: error.message });
    }
});

// Multer storage configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, "uploads");
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    },
});
const upload = multer({ storage });

// Resume upload and analysis endpoint
app.post("/upload", upload.single("resume"), async (req, res) => {
    console.log("File received:", req.file);
    const jobRole = req.body.jobRole;

    if (!req.file) {
        console.error("No file uploaded");
        return res.status(400).json({ success: false, error: "No file uploaded" });
    }
    if (!jobRole) {
        console.error("No job role provided");
        return res.status(400).json({ success: false, error: "No job role provided" });
    }

    let filePath;
    try {
        filePath = req.file.path;
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdfParse(dataBuffer);
        const resumeText = data.text;

        let excelData = loadJobRoles();
        let jobData = excelData.find((item) => item["JOB ROLES"] === jobRole);
        let analysisResult;

        if (jobData) {
            console.log(`Found job role ${jobRole} in Excel data`);
            analysisResult = analyzeResumeFromExcel(resumeText, jobRole, jobData);
        } else {
            console.log(`Job role ${jobRole} not found, querying AI`);
            analysisResult = await analyzeResumeWithAI(resumeText, jobRole);
            analysisResult.fromChatbot = true;
            if (analysisResult.probability !== 0) { // Only save if AI analysis succeeds
                const newJobEntry = {
                    "JOB ROLES": jobRole,
                    "PROGRAMMING SKILLS": analysisResult.requiredSkills || "",
                    "FRAMEWORKS": analysisResult.requiredFrameworks || "",
                };
                excelData.push(newJobEntry);
                console.log(`Attempting to save new job role: ${JSON.stringify(newJobEntry)}`);
                if (!saveExcelData(JOB_ROLES_FILE, excelData)) {
                    console.warn(`Failed to save new job role ${jobRole} to Excel`);
                } else {
                    console.log(`Successfully saved new job role ${jobRole} to Excel`);
                }
            } else {
                console.log(`AI analysis failed for ${jobRole}, skipping save`);
            }
        }

        const response = {
            success: true,
            jobRole,
            probability: analysisResult.probability,
            additionalSkills: analysisResult.additionalSkills,
            additionalFrameworks: analysisResult.additionalFrameworks,
            feedback: analysisResult.feedback,
            fromChatbot: analysisResult.fromChatbot || false,
        };

        res.status(200).json(response);
    } catch (error) {
        console.error("Error processing /upload request:", error);
        res.status(500).json({ success: false, error: "Error processing resume analysis", details: error.message });
    } finally {
        if (filePath && fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
                console.log(`Deleted uploaded file: ${filePath}`);
            } catch (unlinkError) {
                console.error("Error deleting file:", unlinkError);
            }
        }
    }
});

// Chatbot endpoint (unchanged)
app.post("/chatbot", async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: "No message provided" });
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Respond to the following user query naturally and conversationally: "${message}"`;
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        res.status(200).json({ success: true, response: responseText });
    } catch (error) {
        console.error("Chatbot Error:", error);
        res.status(500).json({ success: false, error: "Error processing chatbot request", details: error.message });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error("Global error:", err.stack);
    res.status(500).json({ success: false, error: "Something went wrong!", details: err.message });
});

// Start server
app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
});

// Resume analysis functions (unchanged)
function analyzeResumeFromExcel(resumeText, jobRole, jobData) {
    const requiredSkills = jobData["PROGRAMMING SKILLS"] ? jobData["PROGRAMMING SKILLS"].split(",").map(skill => skill.trim()) : [];
    const requiredFrameworks = jobData["FRAMEWORKS"] ? jobData["FRAMEWORKS"].split(",").map(framework => framework.trim()) : [];
    const skillsFound = [];
    const frameworksFound = [];
    const additionalSkills = [];
    const additionalFrameworks = [];
    let probability = 0;
    let feedback = "Better luck next time. Consider improving your skills.";

    requiredSkills.forEach(skill => {
        if (resumeText.toLowerCase().includes(skill.toLowerCase())) skillsFound.push(skill);
        else additionalSkills.push(skill);
    });

    requiredFrameworks.forEach(framework => {
        if (resumeText.toLowerCase().includes(framework.toLowerCase())) frameworksFound.push(framework);
        else additionalFrameworks.push(framework);
    });

    const skillsProbability = requiredSkills.length ? (skillsFound.length / requiredSkills.length) * 50 : 0;
    const frameworksProbability = requiredFrameworks.length ? (frameworksFound.length / requiredFrameworks.length) * 50 : 0;
    probability = Math.round(skillsProbability + frameworksProbability);

    if (probability === 100) feedback = "Great job! You are a perfect match for this role!";
    else if (probability >= 50) feedback = `You have some required skills. Improve: ${additionalSkills.join(", ")}, ${additionalFrameworks.join(", ")}`;
    else feedback = `Significant improvement needed. Learn: ${additionalSkills.join(", ")}, ${additionalFrameworks.join(", ")}`;

    return {
        probability,
        additionalSkills: additionalSkills.join(", ") || "None",
        additionalFrameworks: additionalFrameworks.join(", ") || "None",
        feedback,
    };
}

async function analyzeResumeWithAI(resumeText, jobRole) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `
        Provide the basic programming languages (skills) and frameworks required for the job role "${jobRole}". 
        Respond in this format:
        - Skills: skill1, skill2
        - Frameworks: framework1, framework2
        `;
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();

        const skillsMatch = responseText.match(/Skills: (.+)/i);
        const frameworksMatch = responseText.match(/Frameworks: (.+)/i);
        const requiredSkills = skillsMatch ? skillsMatch[1].split(',').map(s => s.trim()) : [];
        const requiredFrameworks = frameworksMatch ? frameworksMatch[1].split(',').map(f => f.trim()) : [];

        const skillsFound = [];
        const frameworksFound = [];
        const additionalSkills = [];
        const additionalFrameworks = [];

        requiredSkills.forEach(skill => {
            if (resumeText.toLowerCase().includes(skill.toLowerCase())) skillsFound.push(skill);
            else additionalSkills.push(skill);
        });

        requiredFrameworks.forEach(framework => {
            if (resumeText.toLowerCase().includes(framework.toLowerCase())) frameworksFound.push(framework);
            else additionalFrameworks.push(framework);
        });

        const skillsProbability = requiredSkills.length ? (skillsFound.length / requiredSkills.length) * 50 : 0;
        const frameworksProbability = requiredFrameworks.length ? (frameworksFound.length / requiredFrameworks.length) * 50 : 0;
        const probability = Math.round(skillsProbability + frameworksProbability);

        let feedback = "Better luck next time. Consider improving your skills.";
        if (probability === 100) feedback = "Great job! You are a perfect match for this role!";
        else if (probability >= 50) feedback = `You have some required skills. Improve: ${additionalSkills.join(", ")}, ${additionalFrameworks.join(", ")}`;
        else feedback = `Significant improvement needed. Learn: ${additionalSkills.join(", ")}, ${additionalFrameworks.join(", ")}`;

        return {
            probability,
            additionalSkills: additionalSkills.join(", ") || "None identified",
            additionalFrameworks: additionalFrameworks.join(", ") || "None identified",
            feedback,
            requiredSkills: requiredSkills.join(", "),
            requiredFrameworks: requiredFrameworks.join(", ")
        };
    } catch (error) {
        console.error("AI Analysis Error:", error);
        return {
            probability: 0,
            additionalSkills: "Error analyzing skills",
            additionalFrameworks: "Error analyzing frameworks",
            feedback: "An error occurred while analyzing your resume. Please try again.",
            requiredSkills: "",
            requiredFrameworks: ""
        };
    }
}
