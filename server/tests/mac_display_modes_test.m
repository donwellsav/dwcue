// Exercise the real helper against a switcher that can disappear, offer only
// older timings, or acknowledge a mode change while applying the wrong mode.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ColorSync/ColorSync.h>
#import <IOKit/graphics/IOGraphicsTypes.h>

typedef NSDictionary<NSString *, NSNumber *> Timing;
static CGDirectDisplayID port = 2;
static NSArray<Timing *> *advertised;
static Timing *activeTiming, *pending, *wrongTiming;
static unsigned writes;

static CGError online(uint32_t capacity, CGDirectDisplayID *ids, uint32_t *count) {
    *count = port ? 2 : 1;
    if (capacity >= *count) { ids[0] = 1; if (port) ids[1] = port; }
    return kCGErrorSuccess;
}
static CGError apply(CGConfigureOption scope) {
    if (scope != kCGConfigureForAppOnly) return kCGErrorFailure;
    ++writes;
    activeTiming = wrongTiming ? wrongTiming : pending;
    wrongTiming = nil;
    return kCGErrorSuccess;
}
static Timing *timing(CGDisplayModeRef mode) { return (__bridge Timing *)mode; }
static Timing *makeTiming(int modeID, int height, BOOL interlaced, double hz) {
    return @{@"id": @(modeID), @"w": @(height == 720 ? 1280 : 1920), @"h": @(height), @"hz": @(hz),
        @"flags": @(kDisplayModeTelevisionFlag | kDisplayModeSafeFlag | kDisplayModeValidFlag |
                    (interlaced ? kDisplayModeInterlacedFlag : 0))};
}

#define CGGetOnlineDisplayList online
#define CGDisplayCreateUUIDFromDisplayID(d) CFUUIDCreateFromString(NULL, d == 1 ? CFSTR("00000000-0000-0000-0000-000000000001") : CFSTR("00000000-0000-0000-0000-000000000002"))
#define CGDisplayIsActive(d) ((d) == port || (d) == 1)
#define CGDisplayIsBuiltin(d) ((d) == 1)
#define CGDisplayIsInMirrorSet(d) false
#define CGDisplayIsInHWMirrorSet(d) false
#define CGDisplayCopyAllDisplayModes(d, opts) ((void)(opts), (CFArrayRef)CFBridgingRetain(advertised))
#define CGDisplayCopyDisplayMode(d) ((CGDisplayModeRef)CFBridgingRetain(activeTiming))
#define CGDisplayModeRetain(m) ((CGDisplayModeRef)CFRetain(m))
#define CGDisplayModeRelease(m) do { if (m) CFRelease(m); } while (0)
#define CGDisplayModeGetPixelWidth(m) timing(m)[@"w"].unsignedLongValue
#define CGDisplayModeGetPixelHeight(m) timing(m)[@"h"].unsignedLongValue
#define CGDisplayModeGetWidth CGDisplayModeGetPixelWidth
#define CGDisplayModeGetHeight CGDisplayModeGetPixelHeight
#define CGDisplayModeGetRefreshRate(m) timing(m)[@"hz"].doubleValue
#define CGDisplayModeGetIOFlags(m) timing(m)[@"flags"].unsignedIntValue
#define CGDisplayModeGetIODisplayModeID(m) timing(m)[@"id"].intValue
#define CGBeginDisplayConfiguration(c) ((void)(c), kCGErrorSuccess)
#define CGConfigureDisplayWithDisplayMode(c, d, m, opt) ((d) == port && port != 1 ? (pending = timing(m), kCGErrorSuccess) : kCGErrorFailure)
#define CGCompleteDisplayConfiguration(c, scope) apply(scope)
#define CGCancelDisplayConfiguration(c) ((void)(c))
#define main displayHelperMain
#import "../src/mac_display_modes.m"
#undef main

static void request(NSString *format, BOOL on, BOOL assign) {
    configure(@{@"format": format, @"id": @2, @"control": @1, @"assign": @(assign),
                @"apply": @YES, @"enabled": @(on), @"revision": @(revision + 1)});
}
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "Failed at line %d: %s\n", __LINE__, #x); return 1; } } while (0)

int main(void) {
    @autoreleasepool {
        Timing *sixty = makeTiming(1, 1080, NO, 60), *legacy = makeTiming(2, 1080, YES, 59.93999);
        Timing *hd = makeTiming(3, 720, NO, 59.94), *variant = makeTiming(4, 1080, YES, 59.93999);
        advertised = @[sixty, legacy, hd, variant];
        activeTiming = sixty;
        request(@"auto", NO, YES);
        CHECK(writes == 0 && ![lastReport[@"canPresent"] boolValue]);
        request(@"auto", YES, NO);
        CHECK(activeTiming == legacy && [lastReport[@"chosen"] isEqual:@"1080i59.94"]);
        request(@"1080p59.94", YES, NO);
        CHECK(writes == 1 && [lastReport[@"phase"] isEqual:@"unavailable"] && [lastReport[@"canPresent"] boolValue]);
        NSString *driverMode = nativeKey((__bridge CGDisplayModeRef)variant, targetUUID);
        request(driverMode, YES, NO);
        CHECK(activeTiming == variant && [lastReport[@"phase"] isEqual:@"matched"]);
        wrongTiming = sixty;
        request(@"720p59.94", YES, NO);
        CHECK(activeTiming == variant && [lastReport[@"phase"] isEqual:@"failed"] && [lastReport[@"canPresent"] boolValue]);
        unsigned before = writes;
        inspect(NO);
        CHECK(writes == before && [lastReport[@"phase"] isEqual:@"failed"]);
        request(@"auto", NO, NO);
        CHECK(activeTiming == sixty && ![lastReport[@"restoreFailed"] boolValue]);
        request(@"current", YES, NO);
        request(@"1080p59.94", YES, NO);
        CHECK(activeTiming == sixty && [lastReport[@"canPresent"] boolValue]);
        activeTiming = hd; // An operator changed the Mac mode independently.
        inspect(NO);
        CHECK(![lastReport[@"canPresent"] boolValue] && activeTiming == hd);
        port = 0;
        inspect(NO);
        CHECK([lastReport[@"phase"] isEqual:@"missing"] && ![lastReport[@"canPresent"] boolValue]);
        port = 7; // The same physical switcher returned under a new native ID.
        advertised = @[sixty]; activeTiming = sixty;
        request(@"auto", YES, NO);
        CHECK([lastReport[@"id"] isEqual:@"7"] && [lastReport[@"phase"] isEqual:@"unavailable"] && ![lastReport[@"canPresent"] boolValue]);
        request(@"1080p60.00", YES, NO);
        CHECK([lastReport[@"phase"] isEqual:@"matched"] && [lastReport[@"canPresent"] boolValue]);
    }
    return 0;
}
