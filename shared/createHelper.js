/*
 * Copyright (c) 2016-present, salesforce.com, inc.
 * All rights reserved.
 * Redistribution and use of this software in source and binary forms, with or
 * without modification, are permitted provided that the following conditions
 * are met:
 * - Redistributions of source code must retain the above copyright notice, this
 * list of conditions and the following disclaimer.
 * - Redistributions in binary form must reproduce the above copyright notice,
 * this list of conditions and the following disclaimer in the documentation
 * and/or other materials provided with the distribution.
 * - Neither the name of salesforce.com, inc. nor the names of its contributors
 * may be used to endorse or promote products derived from this software without
 * specific prior written permission of salesforce.com, inc.
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

// Dependencies
var path = require('path'),
    SDK = require('./constants'),
    utils = require('./utils'),
    configHelper = require('./configHelper'),
    prepareTemplate = require('./templateHelper').prepareTemplate,
    getSDKTemplateURI = require('./templateHelper').getSDKTemplateURI,
    fs = require('fs');

// Constant
var SERVER_PROJECT_DIR = 'server';    

//
// Helper for native application creation
//
function createNativeApp(config) {

    // Copying template to projectDir
    utils.copyFile(config.templateLocalPath, config.projectDir);

    // Run prepare function of template
    var prepareResult = prepareTemplate(config, config.projectDir);

    // Cleanup
    utils.removeFile(path.join(config.projectDir, 'template.js'));

    // Done
    return prepareResult;
}

//
// Helper for hybrid application creation
//
function createHybridApp(config) {

    // Create app with cordova
    utils.runProcessThrowError('cordova create "' + config.projectDir + '" ' + config.packagename + ' ' + config.appname);
    utils.runProcessThrowError('npm install shelljs@0.8.5', config.projectDir);

    for (var platform of config.platform.split(',')) {
        utils.runProcessThrowError('cordova platform add ' + platform + '@' + SDK.tools.cordova.platformVersion[platform], config.projectDir);
    }
    utils.runProcessThrowError('cordova plugin add ' + config.cordovaPluginRepoUri + ' --force', config.projectDir);

    // Web directory - the home for the template
    var webDir = path.join(config.projectDir, 'www');
    
    // Remove the default Cordova app.
    utils.removeFile(webDir);

    // Copying template to www
    utils.copyFile(config.templateLocalPath, webDir);

    // Run prepare function of template
    var prepareResult = prepareTemplate(config, webDir);

    // Cleanup
    utils.removeFile(path.join(webDir, 'template.js'));

    // If template includes server side files
    // Create a fresh sfdx project
    // Add cordova js and plugins at static resources
    // Merge files from template into it
    if (utils.dirExists(path.join(webDir, SERVER_PROJECT_DIR))) {
        config.serverDir = path.join(config.projectDir, SERVER_PROJECT_DIR)
        utils.runProcessThrowError('sf force project create -n ' + SERVER_PROJECT_DIR, config.projectDir);

        // Copy cordova js to static resources
        for (var platform of config.platform.split(',')) {
            var cordovaStaticResourcesDir = path.join(config.serverDir, 'force-app', 'main', 'default', 'staticresources', 'cordova' + platform);
            utils.mkDirIfNeeded(cordovaStaticResourcesDir);
            utils.copyFile(path.join(config.projectDir, 'platforms', platform, 'platform_www', '*'), cordovaStaticResourcesDir);
        }

        // Merge server files from templates
        utils.mergeFile(path.join(webDir, SERVER_PROJECT_DIR), config.serverDir);

        // Remove server files from www
        utils.removeFile(path.join(webDir, SERVER_PROJECT_DIR));
    }

    // Run cordova prepare
    utils.runProcessThrowError('cordova prepare', config.projectDir);

    if (config.platform.split(',').indexOf('ios') != -1) {
        if (utils.getToolVersion('xcodebuild -version') < 14000000) {
                // Use legacy build for xcode 13 and older
            useLegacyBuild(config, path.join('platforms', 'ios'));
        } else {
            // Patch podfile for xcode 14
            fixPods(config, path.join('platforms', 'ios'));
        }

        // Remove libCordova.a from build 
        utils.logInfo('Updating xcode project file');
        var xcodeProjectFile = path.join(config.projectDir,'platforms', 'ios', config.appname + '.xcodeproj', 'project.pbxproj')
        var xcodeProjectFileContent = fs.readFileSync(xcodeProjectFile, 'utf8');
        var newXcodeProjectFileContent = xcodeProjectFileContent.split('\n').filter(line => line.indexOf('libCordova.a in Frameworks') == -1).join('\n');
        fs.writeFileSync(xcodeProjectFile, newXcodeProjectFileContent);
        utils.logInfo('Updated xcode project file');
    }
   
    // Done
    return prepareResult;

}

//
// Use legacy build system in XCode
//
function useLegacyBuild(config, iosSubDir) {
    var xcSettingsDir = path.join(config.projectDir, iosSubDir, config.appname + '.xcworkspace', 'xcshareddata')
    var xcSettingsFile = path.join(xcSettingsDir, 'WorkspaceSettings.xcsettings');
    var plistFileContent = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0">\n' + 
        '<dict>\n'  +
        '<key>BuildSystemType</key>\n' + 
        '<string>Original</string>\n' +
        '<key>DisableBuildSystemDeprecationDiagnostic</key>\n' + 
	    '<true/>\n' +
        '</dict>\n' + 
        '</plist>\n';
    utils.logInfo('Creating WorkspaceSettings.xcsettings for project. Setting the BuildSystemType to original in ' + xcSettingsFile);
    utils.mkDirIfNeeded(xcSettingsDir)
    fs.writeFileSync(xcSettingsFile,plistFileContent,'utf8');
    utils.logInfo('Created WorkspaceSettings.xcsettings for project ' + config.appname);
}

//
// Patch pod file for hybrid apps on xcode 14
//
function fixPods(config, iosSubDir) {
    var iosDir = path.join(config.projectDir, iosSubDir)
    var podfilePath = path.join(iosDir, 'Podfile');
    var originalPodfileContent = fs.readFileSync(podfilePath, 'utf8');
    var preInstallCode = "\n" +
	"$dynamic_framework = ['SalesforceAnalytics', 'SalesforceSDKCore', 'SalesforceSDKCommon', 'SmartStore', 'FMDB', 'SQLCipher', 'MobileSync']\n" +
	"pre_install do |installer|\n" +
	"  installer.pod_targets.each do |pod|\n" +
	"    if $dynamic_framework.include?(pod.name)\n" +
	"      def pod.build_type\n" +
	"        Pod::BuildType.dynamic_framework\n" +
	"      end\n" +
	"    end\n" +
	"  end\n" +
	"end" +
	"\n" +
	"post_install do |installer|\n" + 
	"  installer.pods_project.targets.each do |target|\n" + 
	"    if target.deployment_target.to_i < 9\n" + 
	"      target.build_configurations.each do |config|\n" + 
	"        config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '9.0'\n" + 
	"      end\n" + 
	"    end\n" + 
	"  end\n" + 
	"end"

    utils.logInfo('Updating Podfile for project ' + config.appname);
    fs.writeFileSync(podfilePath, originalPodfileContent.replace("use_frameworks!","") + preInstallCode);
    utils.runProcessThrowError('pod update', iosDir);
}

//
// Print details
//
function printDetails(config) {
    // Printing out details
    var details = ['Creating ' + config.platform.replace(',', ' and ') + ' ' + config.apptype + ' application using Salesforce Mobile SDK',
                        '  with app name:        ' + config.appname,
                        '       package name:    ' + config.packagename,
                        '       organization:    ' + config.organization,
                        '',
                        '  in:                   ' + config.projectPath,
                        '',
                        '  from template repo:   ' + config.templaterepouri
                  ];

    if (config.templatepath) {
        details = details.concat(['       template path:   ' + config.templatepath]);
    }
            

    // Hybrid extra details
    if (config.apptype.indexOf('hybrid') >= 0) {
        if (config.apptype === 'hybrid_remote') {
            details = details.concat(['       start page:      ' + config.startpage]);
        }

        details = details.concat(['       plugin repo:     ' + config.cordovaPluginRepoUri]);
    }
            
    utils.logParagraph(details);
}

//
// Print next steps
//
function printNextSteps(ide, projectPath, result) {
    var workspacePath = path.join(projectPath, result.workspacePath);
    var bootconfigFile =  path.join(projectPath, result.bootconfigFile);

    // Printing out next steps
    utils.logParagraph(['Next steps' + (result.platform ? ' for ' + result.platform : '') + ':',
                        '',
                        'Your application project is ready in ' + projectPath + '.',
                        'To use your new application in ' + ide + ', do the following:', 
                        '   - open ' + workspacePath + ' in ' + ide, 
                        '   - build and run', 
                        'Before you ship, make sure to plug your OAuth Client ID and Callback URI,',
                        'and OAuth Scopes into ' + bootconfigFile,
                       ]);
};    

//
// Print next steps for Native Login
// 
function printNextStepsForNativeLogin(ide, projectPath, result) {
    var workspacePath = path.join(projectPath, result.workspacePath);
    var bootconfigFile =  path.join(projectPath, result.bootconfigFile);
    var entryFile = (ide === 'XCode') ? 'SceneDelegate' : 'MainApplication';  

    // Printing out next steps
    utils.logParagraph(['Next steps' + (result.platform ? ' for ' + result.platform : '') + ':',
                        '',
                        'Your application project is ready in ' + projectPath + '.',
                        'To use your new application in ' + ide + ', do the following:', 
                        '   - open ' + workspacePath + ' in ' + ide, 
                        '   - Update the OAuth Client ID, Callback URI, and Community URL in ' + entryFile + ' class.',
                        '   - build and run', 
                        'Before you ship, make sure to plug your OAuth Client ID and Callback URI,',
                        'and OAuth Scopes into ' + bootconfigFile + ', since it is still used for',
                        'authentication if we fallback on the webview.'
                       ]);
}

//
// Print next steps for server project if present
//
function printNextStepsForServerProjectIfNeeded(projectPath) {
    var serverProjectPath = path.join(projectPath, SERVER_PROJECT_DIR);
    var hasServerProject = utils.dirExists(serverProjectPath);
        // Extra steps if there is a server project
    if (hasServerProject) {
        utils.logParagraph(['Your application also has a server project in ' + serverProjectPath + '.',
                            'Make sure to deploy it to your org before running your application.',
                            '',
                            'From ' + projectPath + ' do the following to setup a scratch org, push the server code:',
                            '   - sf force org create -f server/config/project-scratch-def.json -a MyOrg',
                            '   - cd server',
                            '   - sf force source push -u MyOrg',
                            'You also need a password to login to the scratch org from the mobile app:',
                            '   - sf force user password generate -u MyOrg'                            
                            ]);
    }
}

//
// Check tools
//
function checkTools(toolNames) {
    try {
        utils.log("Checking tools");
        for (var toolName of toolNames) {
            utils.checkToolVersion(SDK.tools[toolName].checkCmd, SDK.tools[toolName].minVersion, SDK.tools[toolName].maxVersion, toolName);
        }
    }
    catch (error) {
        utils.logError('Missing tools\n', error);
        process.exit(1);
    }
}

//
// Create app - check tools, read config then actually create app
//
function createApp(forcecli, config) {

    // Can't target ios or run pod if not on a mac
    if (process.platform != 'darwin') {
        forcecli.platforms = forcecli.platforms.filter(p=>p!='ios');
        forcecli.toolNames = forcecli.toolNames.filter(t=>t!='pod');

        if (forcecli.platforms.length == 0) {
            utils.logError('You can only run ' + forcecli.name + ' on a Mac');
            process.exit(1);
        }
    }

    // Check tools
    checkTools(forcecli.toolNames);

    if (config === undefined) {
        // Read parameters from command line
        configHelper.readConfig(process.argv, forcecli, function(config) { actuallyCreateApp(forcecli, config); });
    }
    else {
        // Use parameters passed through
        actuallyCreateApp(forcecli, config);
    }
}

//
// Actually create app
//
function actuallyCreateApp(forcecli, config) {
    try {
        // Adding platform
        if (forcecli.platforms.length == 1) {
            config.platform = forcecli.platforms[0];
        }

        // Adding app type
        if (forcecli.appTypes.length == 1 || config.apptype === undefined || config.apptype === '') {
            config.apptype = forcecli.appTypes[0];
        }

        // Setting log level
        if (config.verbose) {
            utils.setLogLevel(utils.LOG_LEVELS.DEBUG);
        }
        else {
            utils.setLogLevel(utils.LOG_LEVELS.INFO);
        }

        // Computing projectDir
        config.projectDir = config.outputdir ? path.resolve(config.outputdir) : path.join(process.cwd(),config.appname)
        config.projectPath = path.relative(process.cwd(), config.projectDir);

        // Adding version
        config.version = SDK.version;
        
        // Figuring out template repo uri and path
        if (config.templaterepouri) {
            if (!config.templaterepouri.startsWith("https://")) {
                // Given a Mobile SDK template name
                config.templatepath = config.templaterepouri;
                config.templaterepouri = SDK.templatesRepoUri;
            } else {
                // Given a full URI
                var templateUriParsed = utils.separateRepoUrlPathBranch(config.templaterepouri);
                config.templaterepouri = templateUriParsed.repo + '#' + templateUriParsed.branch;
                config.templatepath = templateUriParsed.path;
            }
        }
        else {
            config.templaterepouri = SDK.templatesRepoUri;
            config.templatepath = forcecli.appTypesToPath[config.apptype];
        }

        // Creating tmp dir for template clone
        var tmpDir = utils.mkTmpDir();

        // Cloning template repo
        var repoDir = utils.cloneRepo(tmpDir, config.templaterepouri);
        config.templateLocalPath = path.join(repoDir, config.templatepath);

        // Getting apptype from template
        config.apptype = require(path.join(config.templateLocalPath, 'template.js')).appType;

        var isNative = config.apptype.indexOf('native') >= 0;

        // Adding hybrid only config
        if (!isNative) {
            config.cordovaPluginRepoUri = config.pluginrepouri || SDK.tools.cordova.pluginRepoUri;
        }

        // Print details
        printDetails(config);

        // Creating application
        var results = isNative ? createNativeApp(config) : createHybridApp(config);

        // Cleanup
        utils.removeFile(tmpDir);
        
        // Printing next steps
        if (!(results instanceof Array)) { results = [results] };
        for (var result of results) {
            var ide = SDK.ides[result.platform || config.platform.split(',')[0]];

            if (config.templatepath != undefined && config.templatepath.includes('NativeLogin')) {
                printNextStepsForNativeLogin(ide, config.projectPath, result);
            } else {
                printNextSteps(ide, config.projectPath, result);
            }
        }
        printNextStepsForServerProjectIfNeeded(config.projectPath);

    }
    catch (error) {
        utils.logError(forcecli.name + ' failed\n', error);
        process.exit(1);
    }
}

module.exports = {
    createApp
};
