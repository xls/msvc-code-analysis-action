"use strict";

const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const util = require('util');

const RelativeRulesetPath = '..\\..\\..\\..\\..\\..\\..\\Team Tools\\Static Analysis Tools\\Rule Sets';

/**
 * Add Quoted command-line argument for MSVC that handles spaces and trailing backslashes.
 * @param {*} arg           command-line argument to quote
 * @returns Promise<string> quoted command-lin argument
 */
function escapeArgument(arg) {
  // find number of consecutive trailing backslashes
  let i = 0;
  while (i < arg.length && arg[arg.length - 1 - i] == '\\') {
    i++;
  }

  // escape all trailing backslashes
  if (i > 0) {
    arg += new Array(i + 1).join('\\');
  }

  return '"' + arg + '"';
}

/**
 * Extract the version number of the compiler by depending on the known filepath format inside of
 * Visual Studio.
 * @param {*} path path to the MSVC compiler
 * @returns the MSVC toolset version number
 */
function extractVersionFromCompilerPath(compilerPath) {
  let versionDir = path.join(compilerPath, "../../..");
  return path.basename(versionDir);
}

/**
 * Extract the default compiler includes by searching known directories in the toolset + OS.
 * @param {*} path path to the MSVC compiler
 * @returns array of default includes used by the given MSVC toolset
 */
function extractIncludesFromCompilerPath(compilerPath) {
  let includeDir = path.join(compilerPath, "../../../include");
  // TODO: extract includes from Windows SDK tied to the given toolset.
  return [ path.normalize(includeDir) ];
}

// TODO: replace with io.where
// Find executable relative to the CWD or the system PATH
function findExecutableOnPath(executable) {
  var paths = process.cwd() + ';' + process.env.PATH;
  for (const pathDir of paths.split(';')) {
    const executablePath = path.join(pathDir, executable);
    if (fs.existsSync(executablePath)) {
      return executablePath;
    }
  }

  throw new Error(executable + ' is not accessible on the PATH');
}

/**
 * Validate and resolve action input path by making non-absolute paths relative to
 * GitHub repository root.
 * @param {*} input name of GitHub action input variable
 * @param {*} required if true the input must be non-empty
 * @returns the absolute path to the input path if specified.
 */
function resolveInputPath(input, required = false) {
  let inputPath = core.getInput(input);
  if (!inputPath) {
    if (required) {
      throw new Error(input + " input path can not be empty.");
    }
  }

  if (!path.isAbsolute(inputPath)) {
    // make path relative to the repo root if not absolute
    inputPath = path.join(process.env.GITHUB_WORKSPACE, inputPath);
  }

  return inputPath;
}

/**
 * Helper for iterating over object properties that may not exist
 * @param {*} object object with given optional property
 * @param {*} property property name
 * @returns iterable if exists, otherwise empty array.
 */
function iterateIfExists(object, property) {
  return object && object.hasOwnProperty(property) ? object[property] : [];
}

/**
 * Options to enable/disable different compiler features.
 */
function CompilerCommandOptions() {
  // Use /external command line options to ignore warnings in CMake SYSTEM headers.
  this.ignoreSystemHeaders = core.getInput("ignoreSystemHeaders");
  // TODO: add support to build precompiled headers before running analysis.
  this.usePrecompiledHeaders = false; // core.getInput("usePrecompiledHeaders");
}

/**
 * Class for interacting with the CMake file API.
 */
class CMakeApi {
  constructor() {
    this.loaded = false;

    this.cCompilerInfo = undefined;
    this.cxxCompilerInfo = undefined;

    this.sourceRoot = undefined;
    this.cache = {};
    this.targetFilepaths = [];
  }

  static clientName = "client-msvc-ca-action";

  /**
   * Read and parse json reply file
   * @param {*} replyFile Absolute path to json reply
   * @returns Parsed json data of the reply file
   */
  _parseReplyFile(replyFile) {
    if (!replyFile) {
      throw new Error("Failed to find CMake API reply file.");
    }

    if (!fs.existsSync(replyFile)) {
      throw new Error("Failed to find CMake API reply file: " + replyFile);
    }

    let jsonData = fs.readFileSync(replyFile, err => {
      if (err) {
        throw new Error("Failed to read CMake API reply file: " + replyFile, err);
      }
    });

    return JSON.parse(jsonData);
  }

  /**
   * Create a query file for the CMake API
   * @param {*} apiDir CMake API directory '.cmake/api/v1'
   * @param {*} cmakeVersion CMake version to limit data that can be requested
   */
  _createApiQuery(apiDir) {
    const queryDir = path.join(apiDir, "query", CMakeApi.clientName);
    if (!fs.existsSync(queryDir)) {
      fs.mkdirSync(queryDir, err => {
        if (err) {
          throw new Error("Failed to create CMake Api Query directory.", err);
        }
      });
    }

    const queryData = [
      { kind: "cache", version: "2" },
      { kind: "codemodel", version: "2" },
      { kind: "toolchains", version: "1" }
    ];
    const queryFile = path.join(queryDir, "query.json");
    fs.writeFile(queryFile, JSON.stringify(queryData), err => {
      if (err) {
        throw new Error("Failed to write query.json file for CMake API.", err);
      }
    });
  }

  /**
   * Load the reply index file for the CMake API
   * @param {*} apiDir CMake API directory '.cmake/api/v1'
   * @returns parsed json data for reply/index-xxx.json
   */
  _getApiReplyIndex(apiDir) {
    const replyDir = path.join(apiDir, "reply");
    if (!fs.existsSync(replyDir)) {
      throw new Error("Failed to generate CMake Api Reply files");
    }

    let indexFilepath;
    for (const filepath of fs.readdirSync(replyDir)) {
      if (path.basename(filepath).startsWith("index-")) {
        // Get the most recent index query file (ordered lexicographically)
        if (!indexFilepath || filepath > indexFilepath) {
          indexFilepath = filepath;
        }
      };
    }

    if (!indexFilepath) {
      throw new Error("Failed to find CMake API index reply file.");
    }

    return this._parseReplyFile(indexFilepath);
  }

  /**
   * Load the reply cache file for the CMake API
   * @param {*} cacheJsonFile json filepath for the cache reply data
   */
  _loadCache(cacheJsonFile) {
    const data = this._parseReplyFile(cacheJsonFile);

    // ignore entry type and just store name and string-value pair.
    for (const entry of iterateIfExists(data, 'entries')) {
      this.cache[entry.name] = entry.value;
    }
  }

  /**
   * Load the reply codemodel file for the CMake API
   * @param {*} replyDir directory for CMake API reply files
   * @param {*} codemodelJsonFile json filepath for the codemodel reply data
   */
  _loadCodemodel(replyDir, codemodelJsonFile) {
    const data = this._parseReplyFile(codemodelJsonFile);

    // TODO: let the user decide which configuration in multi-config generators
    for (const target of iterateIfExists(data.configurations[0], 'targets')) {
      this.targetFilepaths.push(path.join(replyDir, target.jsonFile));
    }

    this.sourceRoot = data.paths.source;
  }

  /**
   * Load the reply toolset file for the CMake API
   * @param {*} toolsetJsonFile json filepath for the toolset reply data
   */
  _loadToolchains(toolsetJsonFile) {
    const data = this._parseReplyFile(toolsetJsonFile);

    for (const toolchain of iterateIfExists(data, 'toolchains')) {
      let compiler = toolchain.compiler;
      if (toolchain.language == "C" && compiler.id == "MSVC") {
        this.cCompilerInfo = {
          path: compiler.path,
          version: compiler.version,
          includes: compiler.includeDirectories
        };
      } else if (toolchain.language == "CXX" && compiler.id == "MSVC") {
        this.cxxCompilerInfo = {
          path: compiler.path,
          version: compiler.version,
          includes: compiler.includeDirectories
        };
      }
    }

    if (!this.cCompilerInfo && !this.cxxCompilerInfo) {
      throw new Error("Action requires use of MSVC for either/both C or C++.");
    }
  }

  /**
   * Attempt to load toolset information from CMake cache and known paths because the toolset reply
   * API is not available in CMake version < 3.20
   */
  _loadToolchainsFromCache() {
    let cPath = this.cache["CMAKE_C_COMPILER"];
    if (cPath.endsWith("cl.exe") || cPath.endsWith("cl")) {
      this.cCompilerInfo = {
        path: cPath,
        version: extractVersionFromCompilerPath(cPath),
        includes: extractIncludesFromCompilerPath(cPath)
      };
    }

    let cxxPath = this.cache["CMAKE_CXX_COMPILER"];
    if (cxxPath.endsWith("cl.exe") || cxxPath.endsWith("cl")) {
      this.cxxCompilerInfo = {
        path: cxxPath,
        version: extractVersionFromCompilerPath(cxxPath),
        includes: extractIncludesFromCompilerPath(cxxPath)
      };
    }

    if (!this.cCompilerInfo && !this.cxxCompilerInfo) {
      throw new Error("Action requires use of MSVC for either/both C or C++.");
    }
  }

  /**
   * Load the reply index file for CMake API and load all requested reply responses
   * @param {*} apiDir CMake API directory '.cmake/api/v1'
   */
  _loadReplyFiles(apiDir) {
    const indexReply = this._getApiReplyIndex(apiDir);
    if (indexReply.version.string < "3.13.7") {
      throw new Error("Action requires CMake version >= 3.13.7");
    }

    let cacheLoaded = false;
    let codemodelLoaded = false;
    let toolchainLoaded = false;
    const replyDir = path.join(apiDir, "reply");
    const clientReplies = indexReply.reply[CMakeApi.clientName];
    for (const response of iterateIfExists(clientReplies["query.json"], 'responses')) {
      switch (response["kind"]) {
        case "cache":
          cacheLoaded = true;
          this._loadCache(path.join(replyDir, response.jsonFile));
          break;
        case "codemodel":
          codemodelLoaded = true;
          this._loadCodemodel(replyDir, path.join(replyDir, response.jsonFile));
          break;
        case "toolchains":
          toolchainLoaded = true;
          this._loadToolchains(path.join(replyDir, response.jsonFile));
          break;
        default:
          // do nothing as unsupported responses will be { "error" : "unknown request kind 'xxx'" }
      }
    }

    if (!cacheLoaded) {
      throw new Error("Failed to load cache response from CMake API");
    }

    if (!codemodelLoaded) {
      throw new Error("Failed to load codemodel response from CMake API");
    }

    if (!toolchainLoaded) {
      // Toolchains is only available in CMake >= 3.20.5. Attempt to load from cache.
      this._loadToolchainsFromCache();
    }
  }

  /**
   * Construct compile-command arguments from compile group information.
   * @param {*} group json data for compile-command data
   * @param {*} options options for different command-line options (see getCompileCommands)
   * @returns compile-command arguments joined into one string
   */
  _getCompileGroupArguments(group, options)
  {
    let compileArguments = [];
    for (const command of iterateIfExists(group, 'compileCommandFragments')) {
      compileArguments.push(command.fragment);
    }

    for (const include of iterateIfExists(group, 'includes')) {
      if (options.ignoreSystemHeaders && include.isSystem) {
        // TODO: filter compilers that don't support /external.
        compileArguments.push(escapeArgument(util.format('/external:I%s', include.path)));
      } else {
        compileArguments.push(escapeArgument(util.format('/I%s', include.path)));
      }
    }

    for (const define of iterateIfExists(group, 'defines')) {
      compileArguments.push(escapeArgument(util.format('/D%s', define.define)));
    }

    if (options.usePrecompiledHeaders) {
      // TODO: handle pre-compiled headers
    }

    return compileArguments.join(" ");
  }

  // --------------
  // Public methods
  // --------------

  /**
   * Create a query to the CMake API of an existing already configured CMake project. This will:
   *  - Read existing default reply data to find CMake
   *  - Create a query file for all data needed
   *  - Re-run CMake config to generated reply data
   *  - Read reply data and collect all non-target related info
   * 
   * loadApi is required to call any other methods on this class.
   * @param {*} buildRoot directory of CMake build
   */
  loadApi(buildRoot) {
    if (!buildRoot) {
      throw new Error("CMakeApi: 'buildRoot' can not be null or empty.");
    }

    if (!fs.existsSync(buildRoot)) {
      throw new Error("CMake build root not found at: " + buildRoot);
    } else if (fs.readdirSync(buildRoot).length == 0) {
      throw new Error("CMake build root must be non-empty as project should already be configured");
    }

    // TODO: make code async and replace with io.which("cmake")
    const cmakePath = findExecutableOnPath("cmake.exe");

    const apiDir = path.join(buildRoot, ".cmake/api/v1");

    // read existing reply index to get CMake executable and version
    const indexQuery = this._getApiReplyIndex(apiDir);

    this._createApiQuery(apiDir)

    // regenerate CMake build directory to acquire CMake file API reply
    child_process.spawn(cmakePath, buildRoot, (err) => {
      if (err) {
        throw new Error("Unable to run CMake used previously to build cmake project.");
      }
    });

    const cmakeVersion = indexQuery.version.string;
    if (cmakeVersion < "3.13.7") {
      throw new Error("Action requires CMake version >= 3.13.7");
    }


    if (!fs.existsSync(apiDir)) {
      throw new Error(".cmake/api/v1 missing, run CMake config before using action.");
    }

    this._loadReplyFiles(apiDir);

    this.loaded = true;
  }

  /**
   * Iterate through all CMake targets loaded in the call to 'loadApi' and extract both the compiler and command-line
   * information from every compilation unit in the project. This will only capture C and CXX compilation units that
   * are compiled with MSVC.
   * @param {*} target json filepath for the target reply data
   * @param {CompilerCommandOptions} options options for different compiler features
   * @returns command-line data for each source file in the given target
   */
  * compileCommandsIterator(options = {}) {
    if (!this.loaded) {
      throw new Error("CMakeApi: getCompileCommands called before API is loaded");
    }

    for (let target of this.targetFilepaths) {
      let targetData = this._parseReplyFile(target);
      for (let group of iterateIfExists(targetData, 'compileGroups')) {
        let compilerInfo = undefined;
        switch (group.language) {
          case 'C':
            compilerInfo = this.cCompilerInfo;
            break;
          case 'CXX':
            compilerInfo = this.cxxCompilerInfo;
            break;
        }

        if (compilerInfo) {
          let args = this._getCompileGroupArguments(group, options);
          for (let sourceIndex of iterateIfExists(group, 'sourceIndexes')) {
            let source = path.join(this.sourceRoot, targetData.sources[sourceIndex].path);
            let compileCommand = {
              source: source,
              args: args,
              compiler: compilerInfo
            };
            yield compileCommand;
          }
        }
      }
    }
  }
}

/**
 * Find EspXEngine.dll as it only exists in host/target bin for MSVC Visual Studio release.
 * @param {*} clPath path to the MSVC c ompiler
 * @returns path to EspXEngine.dll
 */
function findEspXEngine(clPath) {
  const clDir = path.dirname(clPath);

  // check if we already have the correct host/target pair
  let dllPath = path.join(clDir, 'EspXEngine.dll');
  if (fs.existsSync(dllPath)) {
    return dllPath;
  }

  let targetName = '';
  let hostDir = path.dirname(clDir);
  switch (path.basename(hostDir)) {
    case 'HostX86':
      targetName = 'x86';
      break;
    case 'HostX64':
      targetName = 'x64';
      break;
    default:
      throw new Error('Unknown MSVC toolset layout');
  }

  dllPath = path.join(hostDir, targetName, 'EspXEngine.dll');
  if (fs.existsSync(dllPath)) {
    return dllPath;
  }

  throw new Error('Unable to find EspXEngine.dll');
}

/**
 * Find official ruleset directory using the known path of MSVC compiler in Visual Studio.
 * @param {*} clPath path to the MSVC compiler
 * @returns path to directory containing all Visual Studio rulesets
 */
function findRulesetDirectory(clPath) {
  const rulesetDirectory = path.normalize(path.join(path.dirname(clPath), RelativeRulesetPath));
  return fs.existsSync(rulesetDirectory) ? rulesetDirectory : undefined;
}

/**
 * Find ruleset first searching relative to GitHub repository and then relative to the official ruleset directory
 * shipped in Visual Studio.
 * @param {*} rulesetDirectory path to directory containing all Visual Studio rulesets
 * @returns path to ruleset found locally or inside Visual Studio
 */
function findRuleset(rulesetDirectory) {
  let repoRulesetPath = resolveInputPath("ruleset");
  if (!repoRulesetPath) {
    return undefined;
  } else if (fs.existsSync(repoRulesetPath)) {
    return repoRulesetPath;
  }

  // search official ruleset directory that ships inside of Visual Studio
  const rulesetPath = core.getInput("ruleset");
  if (rulesetDirectory != undefined) {
    const officialRulesetPath = path.join(rulesetDirectory, rulesetPath);
    if (fs.existsSync(officialRulesetPath)) {
      return officialRulesetPath;
    }
  } else {
    core.warning("Unable to find official rulesets shipped with Visual Studio");
  }

  throw new Error("Unable to fine ruleset specified: " + rulesetPath);
}

/**
 * Construct all command-line arguments that will be common among all sources files of a given compiler.
 * @param {*} clPath path to the MSVC compiler
 * @param {CompilerCommandOptions} options options for different compiler features
 * @returns analyze arguments concatinated into a single string.
 */
function getCommonAnalyzeArguments(clPath, options = {}) {
  args = " /analyze:quiet /analyze:log:format:sarif";

  espXEngine = findEspXEngine(clPath);
  args += escapeArgument(util.format(" /analyze:plugin%s", espXEngine));

  const rulesetDirectory = findRulesetDirectory(clPath);
  const rulesetPath = findRuleset(rulesetDirectory);``
  if (rulesetPath != undefined) {
    args += escapeArgument(util.format(" /analyze:ruleset%s", rulesetPath))

    // add ruleset directories incase user includes any official rulesets
    if (rulesetDirectory != undefined) {
      args += escapeArgument(util.format(" /analyze:rulesetdirectory%s", rulesetDirectory));
    }
  } else {
    core.warning('Ruleset is not being used, all warnings will be enabled.');
  }

  if (options.useExternalIncludes) {
    args += "/analyze:external-";
  }

  return args;
}

/**
 * Get 'results' directory action input and cleanup any stale SARIF files.
 * @returns the absolute path to the 'results' directory for SARIF files.
 */
 function prepareResultsDir() {
  let resultsDir = resolveInputPath("resultsDirectory", true);
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, {recursive: true}, err => {
      if (err) {
        throw new Error("Failed to create 'results' directory which did not exist.");
      }
    });
  }

  let cleanSarif = core.getInput('cleanSarif');
  switch (cleanSarif.toLowerCase()) {
    case 'true':
    {
      // delete existing Sarif files that are consider stale
      for (let file of fs.readdirSync(resultsDir)) {
        if (file.isFile() && path.extname(file.name).toLowerCase() == '.sarif') {
          fs.unlinkSync(path.join(resultsDir, file.name));
        }
      }
      break;
    }
    case 'false':
      break;
    default:
      throw new Error('Unsupported value for \'cleanSarif\'. Must be either \'True\' or \'False\'');
  }

  return resultsDir;
}

/**
 * Main
 */
if (require.main === module) {
  try {
    let buildDir = resolveInputPath("cmakeBuildDirectory", true);
    if (!fs.existsSync(buildDir)) {
      throw new Error("CMake build directory does not exist. Ensure CMake is already configured.");
    }

    api = new CMakeApi();
    api.loadApi(buildDir);

    let resultsDir = prepareResultsDir();

    let analysisRan = false;
    let commonArgCache = {};
    let options = CompilerCommandOptions();
    for (let compileCommand of api.compileCommandsIterator(options)) {
      clPath = compileCommand.compiler.path;
      if (clPath in commonArgCache) {
        commonArgCache[clPath] = getCommonAnalyzeArguments(clPath);
      }

      // add cmake and analyze arguments
      clArguments = compileCommand.args + commonArgCache[clPath];

      // add argument for unique log filepath in results directory
      // TODO: handle clashing source filenames in project
      sarifFile = path.join(resultsDir, path.basename(compileCommand.source));
      clArguments += escapeArgument(util.format(" /analyze:log%s", sarifFile));

      // add source file
      clArguments += compileCommand.source;

      // enable compatibility mode as GitHub does not support some sarif options
      // TODO: only set on child process (NIT)
      process.env.CAEmitSarifLog = 1;

      // TODO: handle errors and stdout better
      spawn(clPath, clArguments);
      analysisRan = true;
    }

    if (!analysisRan) {
      throw new Error('No C/C++ files were found in the project that could be analyzed.');
    }

  } catch (error) {
    core.setFailed(error.message);
  }
}