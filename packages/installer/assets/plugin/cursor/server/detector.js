"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectCommands = detectCommands;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
async function detectCommands(workspacePath) {
    const commands = [];
    const checkFile = (file) => {
        return fs.existsSync(path.join(workspacePath, file));
    };
    // Node.js project detection
    if (checkFile('package.json')) {
        try {
            const packageJsonContent = fs.readFileSync(path.join(workspacePath, 'package.json'), 'utf8');
            const pkg = JSON.parse(packageJsonContent);
            const scripts = pkg.scripts || {};
            // Order of run preference
            if (scripts.build) {
                commands.push('npm run build');
            }
            if (scripts.typecheck) {
                commands.push('npm run typecheck');
            }
            if (scripts.lint) {
                commands.push('npm run lint');
            }
            if (scripts.test) {
                commands.push('npm test');
            }
            else {
                // Fallback if package.json exists but no test script is explicitly defined
                commands.push('npm test');
            }
        }
        catch (e) {
            // In case package.json is invalid JSON or unreadable
            commands.push('npm test');
        }
        return commands;
    }
    // Rust project detection
    if (checkFile('Cargo.toml')) {
        commands.push('cargo check');
        commands.push('cargo test');
        return commands;
    }
    // Go project detection
    if (checkFile('go.mod')) {
        commands.push('go build ./...');
        commands.push('go test ./...');
        return commands;
    }
    // Python project detection
    if (checkFile('pytest.ini') || checkFile('conftest.py') || checkFile('requirements.txt') || checkFile('Pipfile')) {
        // If pytest is typical or manage.py is present for Django, etc.
        if (checkFile('manage.py')) {
            commands.push('python manage.py test');
        }
        else {
            commands.push('pytest');
        }
        return commands;
    }
    // Generic fallback if nothing matches
    return [];
}
