{
  description = "FreeTube + Tabs — A private YouTube client with browser-style tabs";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};

          # package.json is the single place that pins the Electron major.
          # Read it from there instead of restating it. A hardcoded copy of this
          # value drifted once: package.json moved to 42 while the copy stayed
          # at 41, so the build kept running the app on an older Chromium and
          # the guard that exists to catch exactly that stayed quiet.
          packageJson = builtins.fromJSON (builtins.readFile ./package.json);
          electronMajor = builtins.head
            (builtins.match "[^0-9]*([0-9]+)\\..*" packageJson.devDependencies.electron);

          # A missing attribute here fails evaluation loudly, which is the
          # wanted behaviour when nixpkgs has no such major yet.
          electron = pkgs."electron_${electronMajor}";
        in
        {
          default = pkgs.stdenv.mkDerivation rec {
            pname = "freetube-plus-tabs";
            version = "0.24.10";

            src = ./.;

            offlineCache = pkgs.fetchYarnDeps {
              yarnLock = ./yarn.lock;
              hash = "sha256-JiWSOp2YkhR8eo3+6dUl3bceJ8G9QbobRmt9aSMr9Hk=";
            };

            passthru.electronVersion = electron.version;

            nativeBuildInputs = with pkgs; [
              nodejs
              yarn
              yarnConfigHook
              makeWrapper
              copyDesktopItems
            ];

            env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

            # The attribute name is not proof of the version behind it, so check
            # the real one and name both sides if they disagree.
            buildPhase = let
              actualMajor = builtins.head (builtins.splitVersion electron.version);
            in
              assert pkgs.lib.assertMsg (actualMajor == electronMajor)
                "nixpkgs electron_${electronMajor} is Electron ${electron.version}, which is not major ${electronMajor}. Run: nix flake update nixpkgs";
            ''
              runHook preBuild
              node _scripts/patch-youtubei.js
              yarn run pack
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p $out/lib/${pname}
              cp -r dist _icons package.json $out/lib/${pname}/

              makeWrapper ${electron}/bin/electron $out/bin/${pname} \
                --add-flags "--enable-features=AcceleratedVideoDecodeLinuxGL,AcceleratedVideoEncoder,VaapiIgnoreDriverChecks" \
                --add-flags "--enable-gpu-rasterization" \
                --add-flags "--ozone-platform=wayland" \
                --add-flags "$out/lib/${pname}" \
                --set ELECTRON_IS_DEV 0 \
                --set FREETUBE_YTDLP_PATH ${pkgs.yt-dlp}/bin/yt-dlp \
                --prefix PATH : ${pkgs.yt-dlp}/bin \
                --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath [ pkgs.libva ]}"

              install -Dm644 _icons/icon.svg $out/share/icons/hicolor/scalable/apps/${pname}.svg

              runHook postInstall
            '';

            desktopItems = [
              (pkgs.makeDesktopItem {
                name = pname;
                desktopName = "FreeTube + Tabs";
                genericName = "YouTube Client";
                comment = meta.description;
                exec = pname;
                icon = pname;
                terminal = false;
                startupWMClass = "FreeTube + Tabs";
                startupNotify = true;
                categories = [ "AudioVideo" "Network" "Video" ];
                mimeTypes = [ "x-scheme-handler/freetube" ];
              })
            ];

            meta = with pkgs.lib; {
              description = "A private YouTube client with browser-style tabs";
              homepage = "https://github.com/countgitmick/FreeTubePlusTabs";
              license = licenses.agpl3Plus;
              platforms = [ "x86_64-linux" "aarch64-linux" ];
              mainProgram = pname;
            };
          };
        });
    };
}
