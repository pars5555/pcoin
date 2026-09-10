#!/usr/bin/env python3
"""Generate PCoinWallet.xcodeproj from the source tree.

WHY GENERATED RATHER THAN CHECKED IN AS A BLOB. A .pbxproj is a 24-hex-digit
soup that nobody reviews and that merges badly. This script is the source of
truth instead: the file list comes from the filesystem, the identifiers are
derived from the paths so they are stable across runs, and a diff of a
regenerated project shows only what actually changed.

    python contrib/ios/tools/genproj.py

The app target compiles the PCoinWallet sources and depends on the local
PCoinKit package, which is what brings in the vendored libsecp256k1 C target.
That dependency is why PCoinKit is a package at all: `swift test` runs the whole
derivation and signing stack on macOS with no simulator and no signing, and the
app gets the same code through the same manifest.
"""
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
APP = "PCoinWallet"
UITESTS = "PCoinWalletUITests"
BUNDLE_ID = "am.pc.pcoinwallet"
DEPLOYMENT_TARGET = "16.0"


def oid(*parts):
    """A stable 24-hex identifier for a logical object."""
    h = hashlib.sha256("::".join(parts).encode()).hexdigest().upper()
    return h[:24]


def swift_sources():
    out = []
    for sub in ("App", "Model", "Screens", "Components"):
        d = os.path.join(ROOT, APP, sub)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if f.endswith(".swift"):
                out.append((sub, f))
    return out


def uitest_sources():
    d = os.path.join(ROOT, UITESTS)
    if not os.path.isdir(d):
        return []
    return [f for f in sorted(os.listdir(d)) if f.endswith(".swift")]


def main():
    sources = swift_sources()
    uitests = uitest_sources()
    if not sources:
        sys.exit("no Swift sources found under %s" % os.path.join(ROOT, APP))

    proj_dir = os.path.join(ROOT, "%s.xcodeproj" % APP)
    os.makedirs(proj_dir, exist_ok=True)

    # --- object ids -------------------------------------------------------
    PROJECT = oid("project")
    TARGET = oid("target", APP)
    PRODUCT = oid("product", APP)
    MAIN_GROUP = oid("group", "main")
    PRODUCTS_GROUP = oid("group", "products")
    APP_GROUP = oid("group", APP)
    CONFIG_LIST_PROJ = oid("configlist", "project")
    CONFIG_LIST_TARGET = oid("configlist", "target")
    DEBUG_PROJ = oid("config", "project", "Debug")
    RELEASE_PROJ = oid("config", "project", "Release")
    DEBUG_TARGET = oid("config", "target", "Debug")
    RELEASE_TARGET = oid("config", "target", "Release")
    SOURCES_PHASE = oid("phase", "sources")
    FRAMEWORKS_PHASE = oid("phase", "frameworks")
    RESOURCES_PHASE = oid("phase", "resources")
    PKG_REF = oid("pkgref", "PCoinKit")
    PKG_PRODUCT = oid("pkgproduct", "PCoinKit")
    PKG_BUILD_FILE = oid("buildfile", "PCoinKit")
    INFO_PLIST_REF = oid("fileref", "Info.plist")
    UI_TARGET = oid("target", UITESTS)
    UI_PRODUCT = oid("product", UITESTS)
    UI_GROUP = oid("group", UITESTS)
    UI_SOURCES_PHASE = oid("phase", "uisources")
    UI_FRAMEWORKS_PHASE = oid("phase", "uiframeworks")
    UI_RESOURCES_PHASE = oid("phase", "uiresources")
    UI_CONFIG_LIST = oid("configlist", "uitarget")
    UI_DEBUG = oid("config", "uitarget", "Debug")
    UI_RELEASE = oid("config", "uitarget", "Release")
    UI_DEP = oid("dependency", UITESTS)
    UI_PROXY = oid("proxy", UITESTS)

    groups = {}
    for sub, _ in sources:
        groups.setdefault(sub, oid("group", APP, sub))

    ui_refs = [(oid("fileref", UITESTS, n), n) for n in uitests]
    ui_builds = [(oid("buildfile", UITESTS, n), oid("fileref", UITESTS, n), n) for n in uitests]

    file_refs = []
    build_files = []
    for sub, name in sources:
        fr = oid("fileref", sub, name)
        bf = oid("buildfile", sub, name)
        file_refs.append((fr, sub, name))
        build_files.append((bf, fr, sub, name))

    L = []
    w = L.append
    w("// !$*UTF8*$!")
    w("{")
    w("\tarchiveVersion = 1;")
    w("\tclasses = {")
    w("\t};")
    w("\tobjectVersion = 56;")
    w("\tobjects = {")

    # PBXBuildFile
    w("\n/* Begin PBXBuildFile section */")
    for bf, fr, sub, name in build_files:
        w("\t\t%s /* %s in Sources */ = {isa = PBXBuildFile; fileRef = %s /* %s */; };"
          % (bf, name, fr, name))
    w("\t\t%s /* PCoinKit in Frameworks */ = {isa = PBXBuildFile; "
      "productRef = %s /* PCoinKit */; };" % (PKG_BUILD_FILE, PKG_PRODUCT))
    for bf, fr, name in ui_builds:
        w("\t\t%s /* %s in Sources */ = {isa = PBXBuildFile; fileRef = %s /* %s */; };"
          % (bf, name, fr, name))
    w("/* End PBXBuildFile section */")

    # PBXFileReference
    w("\n/* Begin PBXFileReference section */")
    w('\t\t%s /* %s.app */ = {isa = PBXFileReference; explicitFileType = '
      '"wrapper.application"; includeInIndex = 0; path = "%s.app"; '
      'sourceTree = BUILT_PRODUCTS_DIR; };' % (PRODUCT, APP, APP))
    w('\t\t%s /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = '
      'text.plist.xml; path = Info.plist; sourceTree = "<group>"; };' % INFO_PLIST_REF)
    for fr, sub, name in file_refs:
        w('\t\t%s /* %s */ = {isa = PBXFileReference; lastKnownFileType = '
          'sourcecode.swift; path = %s; sourceTree = "<group>"; };' % (fr, name, name))
    w('\t\t%s /* %s.xctest */ = {isa = PBXFileReference; explicitFileType = '
      '"wrapper.cfbundle"; includeInIndex = 0; path = "%s.xctest"; '
      'sourceTree = BUILT_PRODUCTS_DIR; };' % (UI_PRODUCT, UITESTS, UITESTS))
    for fr, name in ui_refs:
        w('\t\t%s /* %s */ = {isa = PBXFileReference; lastKnownFileType = '
          'sourcecode.swift; path = %s; sourceTree = "<group>"; };' % (fr, name, name))
    w("/* End PBXFileReference section */")

    # PBXFrameworksBuildPhase
    w("\n/* Begin PBXFrameworksBuildPhase section */")
    w("\t\t%s /* Frameworks */ = {" % FRAMEWORKS_PHASE)
    w("\t\t\tisa = PBXFrameworksBuildPhase;")
    w("\t\t\tbuildActionMask = 2147483647;")
    w("\t\t\tfiles = (")
    w("\t\t\t\t%s /* PCoinKit in Frameworks */," % PKG_BUILD_FILE)
    w("\t\t\t);")
    w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    w("\t\t};")
    w("\t\t%s /* Frameworks */ = {" % UI_FRAMEWORKS_PHASE)
    w("\t\t\tisa = PBXFrameworksBuildPhase;")
    w("\t\t\tbuildActionMask = 2147483647;")
    w("\t\t\tfiles = (")
    w("\t\t\t);")
    w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    w("\t\t};")
    w("/* End PBXFrameworksBuildPhase section */")

    # PBXGroup
    w("\n/* Begin PBXGroup section */")
    w("\t\t%s = {" % MAIN_GROUP)
    w("\t\t\tisa = PBXGroup;")
    w("\t\t\tchildren = (")
    w("\t\t\t\t%s /* %s */," % (APP_GROUP, APP))
    if uitests:
        w("\t\t\t\t%s /* %s */," % (UI_GROUP, UITESTS))
    w("\t\t\t\t%s /* Products */," % PRODUCTS_GROUP)
    w("\t\t\t);")
    w("\t\t\tsourceTree = \"<group>\";")
    w("\t\t};")

    w("\t\t%s /* Products */ = {" % PRODUCTS_GROUP)
    w("\t\t\tisa = PBXGroup;")
    w("\t\t\tchildren = (")
    w("\t\t\t\t%s /* %s.app */," % (PRODUCT, APP))
    if uitests:
        w("\t\t\t\t%s /* %s.xctest */," % (UI_PRODUCT, UITESTS))
    w("\t\t\t);")
    w("\t\t\tname = Products;")
    w("\t\t\tsourceTree = \"<group>\";")
    w("\t\t};")

    w("\t\t%s /* %s */ = {" % (APP_GROUP, APP))
    w("\t\t\tisa = PBXGroup;")
    w("\t\t\tchildren = (")
    for sub in sorted(groups):
        w("\t\t\t\t%s /* %s */," % (groups[sub], sub))
    w("\t\t\t\t%s /* Info.plist */," % INFO_PLIST_REF)
    w("\t\t\t);")
    w("\t\t\tpath = %s;" % APP)
    w("\t\t\tsourceTree = \"<group>\";")
    w("\t\t};")

    for sub in sorted(groups):
        w("\t\t%s /* %s */ = {" % (groups[sub], sub))
        w("\t\t\tisa = PBXGroup;")
        w("\t\t\tchildren = (")
        for fr, s, name in file_refs:
            if s == sub:
                w("\t\t\t\t%s /* %s */," % (fr, name))
        w("\t\t\t);")
        w("\t\t\tpath = %s;" % sub)
        w("\t\t\tsourceTree = \"<group>\";")
        w("\t\t};")
    if uitests:
        w("\t\t%s /* %s */ = {" % (UI_GROUP, UITESTS))
        w("\t\t\tisa = PBXGroup;")
        w("\t\t\tchildren = (")
        for fr, name in ui_refs:
            w("\t\t\t\t%s /* %s */," % (fr, name))
        w("\t\t\t);")
        w("\t\t\tpath = %s;" % UITESTS)
        w("\t\t\tsourceTree = \"<group>\";")
        w("\t\t};")
    w("/* End PBXGroup section */")

    # PBXNativeTarget
    w("\n/* Begin PBXNativeTarget section */")
    w("\t\t%s /* %s */ = {" % (TARGET, APP))
    w("\t\t\tisa = PBXNativeTarget;")
    w("\t\t\tbuildConfigurationList = %s;" % CONFIG_LIST_TARGET)
    w("\t\t\tbuildPhases = (")
    w("\t\t\t\t%s /* Sources */," % SOURCES_PHASE)
    w("\t\t\t\t%s /* Frameworks */," % FRAMEWORKS_PHASE)
    w("\t\t\t\t%s /* Resources */," % RESOURCES_PHASE)
    w("\t\t\t);")
    w("\t\t\tbuildRules = (")
    w("\t\t\t);")
    w("\t\t\tdependencies = (")
    w("\t\t\t);")
    w("\t\t\tname = %s;" % APP)
    w("\t\t\tpackageProductDependencies = (")
    w("\t\t\t\t%s /* PCoinKit */," % PKG_PRODUCT)
    w("\t\t\t);")
    w("\t\t\tproductName = %s;" % APP)
    w("\t\t\tproductReference = %s /* %s.app */;" % (PRODUCT, APP))
    w("\t\t\tproductType = \"com.apple.product-type.application\";")
    w("\t\t};")
    if uitests:
        w("\t\t%s /* %s */ = {" % (UI_TARGET, UITESTS))
        w("\t\t\tisa = PBXNativeTarget;")
        w("\t\t\tbuildConfigurationList = %s;" % UI_CONFIG_LIST)
        w("\t\t\tbuildPhases = (")
        w("\t\t\t\t%s /* Sources */," % UI_SOURCES_PHASE)
        w("\t\t\t\t%s /* Frameworks */," % UI_FRAMEWORKS_PHASE)
        w("\t\t\t\t%s /* Resources */," % UI_RESOURCES_PHASE)
        w("\t\t\t);")
        w("\t\t\tbuildRules = (")
        w("\t\t\t);")
        w("\t\t\tdependencies = (")
        w("\t\t\t\t%s /* PBXTargetDependency */," % UI_DEP)
        w("\t\t\t);")
        w("\t\t\tname = %s;" % UITESTS)
        w("\t\t\tproductName = %s;" % UITESTS)
        w("\t\t\tproductReference = %s /* %s.xctest */;" % (UI_PRODUCT, UITESTS))
        w("\t\t\tproductType = \"com.apple.product-type.bundle.ui-testing\";")
        w("\t\t};")
    w("/* End PBXNativeTarget section */")

    # PBXProject
    w("\n/* Begin PBXProject section */")
    w("\t\t%s /* Project object */ = {" % PROJECT)
    w("\t\t\tisa = PBXProject;")
    w("\t\t\tattributes = {")
    w("\t\t\t\tBuildIndependentTargetsInParallel = 1;")
    w("\t\t\t\tLastSwiftUpdateCheck = 1620;")
    w("\t\t\t\tLastUpgradeCheck = 1620;")
    w("\t\t\t\tTargetAttributes = {")
    w("\t\t\t\t\t%s = {" % TARGET)
    w("\t\t\t\t\t\tCreatedOnToolsVersion = 16.2;")
    w("\t\t\t\t\t};")
    if uitests:
        w("\t\t\t\t\t%s = {" % UI_TARGET)
        w("\t\t\t\t\t\tCreatedOnToolsVersion = 16.2;")
        w("\t\t\t\t\t\tTestTargetID = %s;" % TARGET)
        w("\t\t\t\t\t};")
    w("\t\t\t\t};")
    w("\t\t\t};")
    w("\t\t\tbuildConfigurationList = %s;" % CONFIG_LIST_PROJ)
    w("\t\t\tcompatibilityVersion = \"Xcode 14.0\";")
    w("\t\t\tdevelopmentRegion = en;")
    w("\t\t\thasScannedForEncodings = 0;")
    w("\t\t\tknownRegions = (")
    w("\t\t\t\ten,")
    w("\t\t\t\tBase,")
    w("\t\t\t);")
    w("\t\t\tmainGroup = %s;" % MAIN_GROUP)
    w("\t\t\tpackageReferences = (")
    w("\t\t\t\t%s /* XCLocalSwiftPackageReference \"PCoinKit\" */," % PKG_REF)
    w("\t\t\t);")
    w("\t\t\tproductRefGroup = %s /* Products */;" % PRODUCTS_GROUP)
    w("\t\t\tprojectDirPath = \"\";")
    w("\t\t\tprojectRoot = \"\";")
    w("\t\t\ttargets = (")
    w("\t\t\t\t%s /* %s */," % (TARGET, APP))
    if uitests:
        w("\t\t\t\t%s /* %s */," % (UI_TARGET, UITESTS))
    w("\t\t\t);")
    w("\t\t};")
    w("/* End PBXProject section */")

    # PBXResourcesBuildPhase
    w("\n/* Begin PBXResourcesBuildPhase section */")
    w("\t\t%s /* Resources */ = {" % RESOURCES_PHASE)
    w("\t\t\tisa = PBXResourcesBuildPhase;")
    w("\t\t\tbuildActionMask = 2147483647;")
    w("\t\t\tfiles = (")
    w("\t\t\t);")
    w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    w("\t\t};")
    if uitests:
        w("\t\t%s /* Resources */ = {" % UI_RESOURCES_PHASE)
        w("\t\t\tisa = PBXResourcesBuildPhase;")
        w("\t\t\tbuildActionMask = 2147483647;")
        w("\t\t\tfiles = (")
        w("\t\t\t);")
        w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
        w("\t\t};")
    w("/* End PBXResourcesBuildPhase section */")

    # PBXSourcesBuildPhase
    w("\n/* Begin PBXSourcesBuildPhase section */")
    w("\t\t%s /* Sources */ = {" % SOURCES_PHASE)
    w("\t\t\tisa = PBXSourcesBuildPhase;")
    w("\t\t\tbuildActionMask = 2147483647;")
    w("\t\t\tfiles = (")
    for bf, fr, sub, name in build_files:
        w("\t\t\t\t%s /* %s in Sources */," % (bf, name))
    w("\t\t\t);")
    w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    w("\t\t};")
    if uitests:
        w("\t\t%s /* Sources */ = {" % UI_SOURCES_PHASE)
        w("\t\t\tisa = PBXSourcesBuildPhase;")
        w("\t\t\tbuildActionMask = 2147483647;")
        w("\t\t\tfiles = (")
        for bf, fr, name in ui_builds:
            w("\t\t\t\t%s /* %s in Sources */," % (bf, name))
        w("\t\t\t);")
        w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
        w("\t\t};")
    w("/* End PBXSourcesBuildPhase section */")

    if uitests:
        w("\n/* Begin PBXTargetDependency section */")
        w("\t\t%s /* PBXTargetDependency */ = {" % UI_DEP)
        w("\t\t\tisa = PBXTargetDependency;")
        w("\t\t\ttarget = %s /* %s */;" % (TARGET, APP))
        w("\t\t\ttargetProxy = %s /* PBXContainerItemProxy */;" % UI_PROXY)
        w("\t\t};")
        w("/* End PBXTargetDependency section */")

        w("\n/* Begin PBXContainerItemProxy section */")
        w("\t\t%s /* PBXContainerItemProxy */ = {" % UI_PROXY)
        w("\t\t\tisa = PBXContainerItemProxy;")
        w("\t\t\tcontainerPortal = %s /* Project object */;" % PROJECT)
        w("\t\t\tproxyType = 1;")
        w("\t\t\tremoteGlobalIDString = %s;" % TARGET)
        w("\t\t\tremoteInfo = %s;" % APP)
        w("\t\t};")
        w("/* End PBXContainerItemProxy section */")

    # XCBuildConfiguration
    common = [
        ("ALWAYS_SEARCH_USER_PATHS", "NO"),
        ("CLANG_ENABLE_MODULES", "YES"),
        ("CLANG_ENABLE_OBJC_ARC", "YES"),
        ("ENABLE_STRICT_OBJC_MSGSEND", "YES"),
        ("ENABLE_USER_SCRIPT_SANDBOXING", "NO"),
        ("GCC_C_LANGUAGE_STANDARD", "gnu17"),
        ("IPHONEOS_DEPLOYMENT_TARGET", DEPLOYMENT_TARGET),
        ("SDKROOT", "iphoneos"),
        ("SWIFT_VERSION", "5.0"),
    ]
    target_common = [
        ("CODE_SIGN_STYLE", "Automatic"),
        ("CURRENT_PROJECT_VERSION", "1"),
        ("GENERATE_INFOPLIST_FILE", "NO"),
        ("INFOPLIST_FILE", "%s/Info.plist" % APP),
        ("MARKETING_VERSION", "0.1.0"),
        ("PRODUCT_BUNDLE_IDENTIFIER", BUNDLE_ID),
        ("PRODUCT_NAME", "\"$(TARGET_NAME)\""),
        ("SWIFT_EMIT_LOC_STRINGS", "YES"),
        ("TARGETED_DEVICE_FAMILY", "1"),
    ]

    def config(ident, name, settings, extra):
        w("\t\t%s /* %s */ = {" % (ident, name))
        w("\t\t\tisa = XCBuildConfiguration;")
        w("\t\t\tbuildSettings = {")
        for k, v in settings + extra:
            w("\t\t\t\t%s = %s;" % (k, v))
        w("\t\t\t};")
        w("\t\t\tname = %s;" % name)
        w("\t\t};")

    w("\n/* Begin XCBuildConfiguration section */")
    config(DEBUG_PROJ, "Debug", common, [
        ("DEBUG_INFORMATION_FORMAT", "dwarf"),
        ("GCC_OPTIMIZATION_LEVEL", "0"),
        ("GCC_PREPROCESSOR_DEFINITIONS", "\"DEBUG=1 $(inherited)\""),
        ("ONLY_ACTIVE_ARCH", "YES"),
        # Without this, `#if DEBUG` is FALSE in a Debug build. Xcode templates
        # set it and a hand-written project does not, which is a silent and
        # confusing difference: the UI tests failed for an hour because the
        # `-uiTestResetWallet` hook -- correctly guarded by `#if DEBUG` -- was
        # compiled out of the very build that was meant to have it.
        ("SWIFT_ACTIVE_COMPILATION_CONDITIONS", "DEBUG"),
        ("SWIFT_OPTIMIZATION_LEVEL", "\"-Onone\""),
    ])
    config(RELEASE_PROJ, "Release", common, [
        ("DEBUG_INFORMATION_FORMAT", "\"dwarf-with-dsym\""),
        ("SWIFT_COMPILATION_MODE", "wholemodule"),
        ("VALIDATE_PRODUCT", "YES"),
    ])
    config(DEBUG_TARGET, "Debug", target_common, [])
    config(RELEASE_TARGET, "Release", target_common, [])
    if uitests:
        ui_common = [
            ("CODE_SIGN_STYLE", "Automatic"),
            ("CURRENT_PROJECT_VERSION", "1"),
            ("GENERATE_INFOPLIST_FILE", "YES"),
            ("MARKETING_VERSION", "1.0"),
            ("PRODUCT_BUNDLE_IDENTIFIER", "%s.uitests" % BUNDLE_ID),
            ("PRODUCT_NAME", "\"$(TARGET_NAME)\""),
            ("SWIFT_EMIT_LOC_STRINGS", "NO"),
            ("TARGETED_DEVICE_FAMILY", "1"),
            ("TEST_TARGET_NAME", APP),
        ]
        config(UI_DEBUG, "Debug", ui_common, [])
        config(UI_RELEASE, "Release", ui_common, [])
    w("/* End XCBuildConfiguration section */")

    # XCConfigurationList
    w("\n/* Begin XCConfigurationList section */")
    for ident, dbg, rel, label in (
        (CONFIG_LIST_PROJ, DEBUG_PROJ, RELEASE_PROJ, "PBXProject"),
        (CONFIG_LIST_TARGET, DEBUG_TARGET, RELEASE_TARGET, "PBXNativeTarget"),
    ) + ((( UI_CONFIG_LIST, UI_DEBUG, UI_RELEASE, "PBXNativeTarget"),) if uitests else ()):
        w("\t\t%s /* Build configuration list for %s */ = {" % (ident, label))
        w("\t\t\tisa = XCConfigurationList;")
        w("\t\t\tbuildConfigurations = (")
        w("\t\t\t\t%s /* Debug */," % dbg)
        w("\t\t\t\t%s /* Release */," % rel)
        w("\t\t\t);")
        w("\t\t\tdefaultConfigurationIsVisible = 0;")
        w("\t\t\tdefaultConfigurationName = Release;")
        w("\t\t};")
    w("/* End XCConfigurationList section */")

    # XCLocalSwiftPackageReference / XCSwiftPackageProductDependency
    w("\n/* Begin XCLocalSwiftPackageReference section */")
    w("\t\t%s /* XCLocalSwiftPackageReference \"PCoinKit\" */ = {" % PKG_REF)
    w("\t\t\tisa = XCLocalSwiftPackageReference;")
    w("\t\t\trelativePath = PCoinKit;")
    w("\t\t};")
    w("/* End XCLocalSwiftPackageReference section */")

    w("\n/* Begin XCSwiftPackageProductDependency section */")
    w("\t\t%s /* PCoinKit */ = {" % PKG_PRODUCT)
    w("\t\t\tisa = XCSwiftPackageProductDependency;")
    w("\t\t\tproductName = PCoinKit;")
    w("\t\t};")
    w("/* End XCSwiftPackageProductDependency section */")

    w("\t};")
    w("\trootObject = %s /* Project object */;" % PROJECT)
    w("}")

    path = os.path.join(proj_dir, "project.pbxproj")
    with open(path, "w", newline="\n") as fh:
        fh.write("\n".join(L) + "\n")

    # A scheme, so `xcodebuild -scheme PCoinWallet` works without opening Xcode.
    schemes = os.path.join(proj_dir, "xcshareddata", "xcschemes")
    os.makedirs(schemes, exist_ok=True)
    with open(os.path.join(schemes, "%s.xcscheme" % APP), "w", newline="\n") as fh:
        testables = ""
        if uitests:
            testables = TESTABLE % {"app": APP, "uitests": UITESTS, "uitarget": UI_TARGET}
        fh.write(SCHEME % {
            "app": APP, "target": TARGET, "product": PRODUCT, "testables": testables,
        })

    print("wrote %s (%d Swift files)" % (path, len(sources)))


SCHEME = '''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1620" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES"
            buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "%(target)s"
               BuildableName = "%(app)s.app"
               BlueprintName = "%(app)s"
               ReferencedContainer = "container:%(app)s.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
%(testables)s      </Testables>
   </TestAction>
   <LaunchAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle = "0"
      useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES" debugServiceExtension = "internal" allowLocationSimulation = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "%(target)s"
            BuildableName = "%(app)s.app"
            BlueprintName = "%(app)s"
            ReferencedContainer = "container:%(app)s.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration = "Release" shouldUseLaunchSchemeArgsEnv = "YES"
      savedToolIdentifier = "" useCustomWorkingDirectory = "NO" debugDocumentVersioning = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "%(target)s"
            BuildableName = "%(app)s.app"
            BlueprintName = "%(app)s"
            ReferencedContainer = "container:%(app)s.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction buildConfiguration = "Debug"></AnalyzeAction>
   <ArchiveAction buildConfiguration = "Release" revealArchiveInOrganizer = "YES"></ArchiveAction>
</Scheme>
'''


TESTABLE = """         <TestableReference skipped = "NO">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "%(uitarget)s"
               BuildableName = "%(uitests)s.xctest"
               BlueprintName = "%(uitests)s"
               ReferencedContainer = "container:%(app)s.xcodeproj">
            </BuildableReference>
         </TestableReference>
"""


if __name__ == "__main__":
    main()
