import { z } from 'zod';
import { ValidationError } from '../../errors/index.js';
import { generateTestsTool } from '../tools/generate-tests.js';
import { handleError, logError } from '../../utils/errorHandler.js';
import { ListSkillsInputSchema, UninstallInputSchema, GenerateTestsInputSchema, formatValidationError, } from '../validation.js';
export class SystemToolHandler {
    skillManager;
    uninstallManager;
    samplingClient;
    constructor(skillManager, uninstallManager, samplingClient) {
        this.skillManager = skillManager;
        this.uninstallManager = uninstallManager;
        this.samplingClient = samplingClient;
    }
    async handleListSkills(args) {
        try {
            let validatedInput;
            try {
                validatedInput = ListSkillsInputSchema.parse(args);
            }
            catch (error) {
                if (error instanceof z.ZodError) {
                    throw new ValidationError(formatValidationError(error), {
                        component: 'ToolHandlers',
                        method: 'handleListSkills',
                        schema: 'ListSkillsInputSchema',
                        providedArgs: args,
                    });
                }
                throw error;
            }
            const filter = validatedInput.filter || 'all';
            let skills;
            let title;
            switch (filter) {
                case 'claude-code-buddy':
                    skills = await this.skillManager.listSmartAgentsSkills();
                    title = 'MeMesh Skills (sa: prefix)';
                    break;
                case 'user':
                    skills = await this.skillManager.listUserSkills();
                    title = 'User Skills';
                    break;
                case 'all':
                default:
                    const allSkillsMetadata = await this.skillManager.listAllSkills();
                    skills = allSkillsMetadata.map(s => s.name);
                    title = 'All Skills';
                    break;
            }
            let output = `${title}\n`;
            output += '='.repeat(60) + '\n\n';
            if (skills.length === 0) {
                output += '  No skills found.\n\n';
                if (filter === 'claude-code-buddy') {
                    output += 'MeMesh can generate skills automatically.\n';
                    output += 'Skills will appear here once generated.\n';
                }
            }
            else {
                output += `Total: ${skills.length} skill${skills.length === 1 ? '' : 's'}\n\n`;
                const saSkills = skills.filter(s => s.startsWith('sa:'));
                const userSkills = skills.filter(s => !s.startsWith('sa:'));
                if (filter === 'all') {
                    if (saSkills.length > 0) {
                        output += 'MeMesh Skills:\n';
                        output += '-'.repeat(60) + '\n';
                        saSkills.forEach(skill => {
                            output += `  - ${skill}\n`;
                        });
                        output += '\n';
                    }
                    if (userSkills.length > 0) {
                        output += 'User Skills:\n';
                        output += '-'.repeat(60) + '\n';
                        userSkills.forEach(skill => {
                            output += `  - ${skill}\n`;
                        });
                        output += '\n';
                    }
                }
                else {
                    skills.forEach(skill => {
                        output += `  - ${skill}\n`;
                    });
                    output += '\n';
                }
            }
            output += '='.repeat(60) + '\n';
            output += '\nUsage:\n';
            output += '  - buddy_skills - List all skills\n';
            output += '  - buddy_skills --filter claude-code-buddy - List only sa: skills\n';
            output += '  - buddy_skills --filter user - List only user skills\n';
            output += '\nSkill Naming Convention:\n';
            output += '  - sa:<name> - MeMesh generated skills\n';
            output += '  - <name> - User-installed skills\n';
            return {
                content: [
                    {
                        type: 'text',
                        text: output,
                    },
                ],
            };
        }
        catch (error) {
            logError(error, {
                component: 'ToolHandlers',
                method: 'handleListSkills',
                operation: 'listing skills',
                data: { filter: args?.filter },
            });
            const handled = handleError(error, {
                component: 'ToolHandlers',
                method: 'handleListSkills',
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: `List skills failed: ${handled.message}`,
                    },
                ],
            };
        }
    }
    async handleUninstall(args) {
        try {
            let validatedInput;
            try {
                validatedInput = UninstallInputSchema.parse(args);
            }
            catch (error) {
                if (error instanceof z.ZodError) {
                    throw new ValidationError(formatValidationError(error), {
                        component: 'ToolHandlers',
                        method: 'handleUninstall',
                        schema: 'UninstallInputSchema',
                        providedArgs: args,
                    });
                }
                throw error;
            }
            const report = await this.uninstallManager.uninstall(validatedInput);
            const formattedReport = this.uninstallManager.formatReport(report);
            return {
                content: [
                    {
                        type: 'text',
                        text: formattedReport,
                    },
                ],
            };
        }
        catch (error) {
            logError(error, {
                component: 'ToolHandlers',
                method: 'handleUninstall',
                operation: 'uninstalling MeMesh',
                data: { options: args },
            });
            const handled = handleError(error, {
                component: 'ToolHandlers',
                method: 'handleUninstall',
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Uninstall failed: ${handled.message}`,
                    },
                ],
            };
        }
    }
    async handleGenerateTests(args) {
        try {
            const validatedInput = GenerateTestsInputSchema.parse(args);
            const input = validatedInput;
            const result = await generateTestsTool(input, this.samplingClient);
            let text = 'Test Generation Result\n';
            text += '='.repeat(60) + '\n\n';
            text += `${result.message}\n\n`;
            text += '```typescript\n';
            text += result.testCode;
            text += '\n```\n\n';
            text += '='.repeat(60) + '\n';
            text += '\nNext Steps:\n';
            text += '  - Review the generated tests for accuracy\n';
            text += '  - Adjust test cases as needed\n';
            text += '  - Add edge cases if necessary\n';
            text += '  - Run tests to verify they pass\n';
            return {
                content: [
                    {
                        type: 'text',
                        text,
                    },
                ],
            };
        }
        catch (error) {
            logError(error, {
                component: 'ToolHandlers',
                method: 'handleGenerateTests',
                operation: 'generating tests',
                data: { args },
            });
            const handled = handleError(error, {
                component: 'ToolHandlers',
                method: 'handleGenerateTests',
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to generate tests: ${handled.message}`,
                    },
                ],
            };
        }
    }
}
//# sourceMappingURL=SystemToolHandler.js.map