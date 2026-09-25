.PHONY: setup install test test-js test-rust e2e preview icons uninstall clean

# Python environment, models and the default voice, all inside this folder.
setup:
	sh scripts/setup.sh

# Build the native host and register it with the installed browsers.
install:
	sh scripts/install-host-macos.sh

test: test-js test-rust

test-js:
	node --test tests/

test-rust:
	cargo test --quiet

# Real YouTube in a throwaway Chrome for Testing profile. YouTube tends to stop
# playback in an automated browser after a minute, so keep runs short.
e2e:
	cd e2e && npm install --silent
	node e2e/run.mjs $(or $(VIDEO),cMX-u9ltG5Q) $(or $(START),600) $(or $(PHRASES),6) \
	  $(if $(INTO),--into=$(INTO)) $(if $(FROM),--from=$(FROM))

# The panel in every state and interface language, as PNGs in .e2e/.
preview:
	cd e2e && npm install --silent
	node e2e/panel-preview.mjs

# Rebuild the PNG icons from extension/icons/lion.svg.
icons:
	sh scripts/render-icons.sh

uninstall:
	rm -f "$(HOME)/Library/Application Support/Google/Chrome/NativeMessagingHosts/org.local_youtube_dub.host.json" \
	      "$(HOME)/Library/Application Support/Microsoft Edge/NativeMessagingHosts/org.local_youtube_dub.host.json" \
	      "$(HOME)/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/org.local_youtube_dub.host.json" \
	      "$(HOME)/Library/Application Support/Chromium/NativeMessagingHosts/org.local_youtube_dub.host.json"

# Build output only; models, voices and the transcript cache are kept.
clean:
	rm -rf target bin
