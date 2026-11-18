// Spike S-2 stand-in for the menu bar shell (E-002 brings the real one): the main executable of
// "LFCP Bridge.app". It runs the bundled Node on the bundled host by absolute paths found from its
// own location (no PATH, no NODE_PATH), passing its arguments through:
//   Contents/MacOS/LFCP Bridge <args>  →  Contents/Resources/node/bin/node Contents/Resources/host/bridge.mjs <args>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char *argv[]) {
  char exe[PATH_MAX], real[PATH_MAX], contents[PATH_MAX], node[PATH_MAX], host[PATH_MAX];
  uint32_t size = sizeof exe;
  if (_NSGetExecutablePath(exe, &size) != 0 || realpath(exe, real) == NULL) {
    fprintf(stderr, "LFCP Bridge: cannot find its own executable\n");
    return 70;
  }
  // .../Contents/MacOS/LFCP Bridge → .../Contents
  snprintf(contents, sizeof contents, "%s", dirname(dirname(real)));
  snprintf(node, sizeof node, "%s/Resources/node/bin/node", contents);
  snprintf(host, sizeof host, "%s/Resources/host/bridge.mjs", contents);
  char **args = calloc((size_t)argc + 2, sizeof *args);
  if (args == NULL) return 71;
  args[0] = node;
  args[1] = host;
  for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
  execv(node, args);
  perror("LFCP Bridge: execv node");
  return 72;
}
