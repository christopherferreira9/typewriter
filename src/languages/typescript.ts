import { string } from "joi";
import path from "path";
import {
  Name,
  RenderContext,
  TargetLanguage,
  tsFlowOptions,
  Type,
  TypeScriptRenderer,
  TypeScriptTargetLanguage,
  ObjectType,
  ClassProperty,
} from "quicktype-core";
import {
  getOptionValues,
  OptionValues,
} from "quicktype-core/dist/RendererOptions";
import { camelCase } from "quicktype-core/dist/support/Strings";
import { SegmentAPI } from "../api";
import {
  createQuicktypeLanguageGenerator,
  emitMultiline,
  executeRenderPlan,
  makeNameForTopLevelWithPrefixAndSuffix,
} from "./quicktype-utils";
import {
  FileGenerateResult,
  GeneratorOptions,
  LanguageGenerator,
  QuicktypeTypewriterSettings,
  TemplateContext,
} from "./types";

// To add our own functions we need to extend the renderer for the language we are targeting
class TypewriterTypescriptRenderer extends TypeScriptRenderer {
  constructor(
    targetLanguage: TargetLanguage,
    renderContext: RenderContext,
    typescriptOptions: OptionValues<any>,
    protected readonly typewriterOptions: QuicktypeTypewriterSettings
  ) {
    super(targetLanguage, renderContext, typescriptOptions);
  }

  emitMultiline(linesString: string) {
    emitMultiline(this, linesString, 2);
  }

  emitSource(givenOutputFilename: string): void {
    super.emitSource(givenOutputFilename);
    executeRenderPlan(this, this.typewriterOptions.generators);
  }

  makeNameForTopLevel(
    t: Type,
    givenName: string,
    maybeNamedType: Type | undefined
  ): Name {
    return makeNameForTopLevelWithPrefixAndSuffix(
      (...args) => {
        return super.makeNameForTopLevel(...args);
      },
      this.typewriterOptions,
      t,
      givenName,
      maybeNamedType
    );
  }

  protected emitType(t: Type, name: Name): void {
    // For all types, use default behavior instead of trying to customize
    // The TypeScriptRenderer doesn't have an emitType method, so we'll skip this
    // Post-processing will handle our custom logic
  }
}

// We extend one of the target languages in quicktype to add our own functions
// This is only necesary to make it use our own renderer
class TypewriterTSLanguage extends TypeScriptTargetLanguage {
  constructor(
    protected readonly typewriterOptions: QuicktypeTypewriterSettings
  ) {
    super();
  }

  protected makeRenderer(
    renderContext: RenderContext,
    untypedOptionValues: { [name: string]: any }
  ): TypewriterTypescriptRenderer {
    return new TypewriterTypescriptRenderer(
      this,
      renderContext,
      getOptionValues(tsFlowOptions, untypedOptionValues),
      this.typewriterOptions
    );
  }
}

// Function to post-process the TypeScript files to enforce required properties
function postProcessTypescriptFiles(files: FileGenerateResult): FileGenerateResult {
  const processedFiles = new Map<string, string>();
  
  for (const [filename, content] of files.entries()) {
    let processedContent = content;
    
    // Find all TEST interfaces and their properties interfaces
    const testInterfaceRegex = /export interface (\w+TEST) {[\s\S]*?properties\?:\s+(\w+Properties);[\s\S]*?}/g;
    const propertiesRegex = /export interface (\w+Properties) {([\s\S]*?)}/g;
    
    // Find required properties
    const requiredPropsMap = new Map<string, string[]>();
    let propertiesMatch;
    while ((propertiesMatch = propertiesRegex.exec(processedContent)) !== null) {
      const propertiesInterfaceName = propertiesMatch[1];
      const propertiesBody = propertiesMatch[2];
      
      // Extract properties without a ? (required properties)
      const requiredProps: string[] = [];
      const propRegex = /(\w+):\s+/g;
      let propMatch;
      
      while ((propMatch = propRegex.exec(propertiesBody)) !== null) {
        if (!propertiesBody.substring(propMatch.index - 1, propMatch.index).includes('?')) {
          requiredProps.push(propMatch[1]);
        }
      }
      
      if (requiredProps.length > 0) {
        requiredPropsMap.set(propertiesInterfaceName, requiredProps);
      }
    }
    
    // Process each TEST interface
    let testMatch;
    const processedInterfaces = new Set<string>();
    
    while ((testMatch = testInterfaceRegex.exec(processedContent)) !== null) {
      const interfaceName = testMatch[1];
      const propertiesInterfaceName = testMatch[2];
      
      if (requiredPropsMap.has(propertiesInterfaceName) && !processedInterfaces.has(interfaceName)) {
        processedInterfaces.add(interfaceName);
        const requiredProps = requiredPropsMap.get(propertiesInterfaceName)!;
        const functionName = interfaceName.replace(/TEST$/, '');
        
        // The types to use for enforcing required properties
        const typingHelpers = `
// Validation types for ${interfaceName}
export type ${interfaceName}WithoutProperties = Omit<${interfaceName}, 'properties'>;
export type ${interfaceName}WithRequiredProperties = ${interfaceName}WithoutProperties & {
  properties: {
    ${requiredProps.map(prop => `${prop}: ${propertiesInterfaceName}['${prop}'];`).join('\n    ')}
  } & Partial<${propertiesInterfaceName}>;
};

// Runtime validator to enforce required properties when provided
function validate${interfaceName}(data: ${interfaceName}): void {
  if (data.properties) {
    const missingProps: string[] = [];
    ${requiredProps.map(prop => 
      `if (data.properties.${prop} === undefined) missingProps.push('${prop}');`
    ).join('\n    ')}
    
    if (missingProps.length > 0) {
      throw new Error(\`Missing required properties in ${interfaceName}: \${missingProps.join(', ')}\`);
    }
  }
}`;
        
        // Add the helper type after the interface
        processedContent = processedContent.replace(
          testMatch[0],
          testMatch[0] + typingHelpers
        );
        
        // Update TypewriterSegmentClient type for React Native
        const clientTypePattern = new RegExp(`(${functionName}):\\s*\\(message:\\s*${interfaceName}\\)\\s*=>\\s*void,`, 'g');
        processedContent = processedContent.replace(clientTypePattern, 
          `$1: {
    // When properties is omitted - allowed
    (message: ${interfaceName}WithoutProperties): void;
    // When properties is included, must have required properties
    (message: ${interfaceName}WithRequiredProperties): void;
  },`
        );
        
        // Update client implementation for React Native
        const clientImplPattern = new RegExp(`(${functionName})\\s*=\\s*\\(message:\\s*${interfaceName}\\)\\s*=>\\s*{`, 'g');
        processedContent = processedContent.replace(clientImplPattern,
          `$1 = (message: ${interfaceName}WithoutProperties | ${interfaceName}WithRequiredProperties) => {
    validate${interfaceName}(message as ${interfaceName});`
        );
        
        // Update empty function stubs in useAnalytics
        const emptyFuncPattern = new RegExp(`(${functionName}):\\s*async\\(\\)\\s*=>\\s*{},`, 'g');
        processedContent = processedContent.replace(emptyFuncPattern,
          `$1: {
        // When properties is omitted - allowed
        (message: ${interfaceName}WithoutProperties): void;
        // When properties is included, must have required properties
        (message: ${interfaceName}WithRequiredProperties): void;
      },`
        );
        
        // For analytics.js or node
        const functionPattern = new RegExp(`export\\s+function\\s+(${functionName})\\s*\\((?:props|message):\\s*${interfaceName}[^)]*\\)`, 'g');
        processedContent = processedContent.replace(functionPattern,
          `// When properties is omitted - allowed
export function $1(props: ${interfaceName}WithoutProperties): void;
// When properties is included, must have required properties
export function $1(props: ${interfaceName}WithRequiredProperties): void;
// Implementation
export function $1(props: ${interfaceName}WithoutProperties | ${interfaceName}WithRequiredProperties)`
        );
        
        // Add validator call to function implementation
        const implementationPattern = new RegExp(`client\\.track\\('.*?',\\s*message\\s+as\\s+${interfaceName}\\);`, 'g');
        processedContent = processedContent.replace(implementationPattern,
          (match) => `validate${interfaceName}(message as ${interfaceName});\n    ${match}`
        );
      }
    }
    
    processedFiles.set(filename, processedContent);
  }
  
  return processedFiles;
}

const tsBase = createQuicktypeLanguageGenerator({
  name: "typescript",
  quicktypeLanguage: TypewriterTSLanguage,
  supportedSDKs: [
    {
      name: "Node.js (analytics-node)",
      id: "analytics-node",
      templatePath: "templates/typescript/node.hbs",
    },
    {
      name: "Web (analytics.js)",
      id: "analytics-js",
      templatePath: "templates/typescript/analytics-js.hbs",
    },
    {
      name: "React Native (analytics-react-native)",
      id: "analytics-react-native",
      templatePath: "templates/typescript/react-native.hbs",
    },
    {
      name: "None (Types and validation only)",
      id: "none",
    },
  ],
  defaultOptions: {
    "just-types": true,
  },
  nameModifiers: {
    functionName: camelCase,
  },
});

export const typescript: LanguageGenerator = {
  ...tsBase,
  generate: async (
    rules: SegmentAPI.RuleMetadata[],
    context: TemplateContext,
    options: GeneratorOptions
  ): Promise<FileGenerateResult> => {
    const { sdk, prefixes, suffixes } = options;
    const result = await tsBase.generate(rules, context, options);
    
    // Post-process the TypeScript files
    const processedResult = postProcessTypescriptFiles(result);
    
    // We edit the RN output to include the TSX extension
    if (sdk === "analytics-react-native") {
      const tsxResult = new Map<string, string>();
      for (const [filename, contents] of processedResult.entries()) {
        if (path.extname(filename) === ".ts") {
          tsxResult.set(`${filename}x`, contents);
        } else {
          tsxResult.set(`${filename}.tsx`, contents);
        }
      }
      return tsxResult;
    }
    return processedResult;
  },
};