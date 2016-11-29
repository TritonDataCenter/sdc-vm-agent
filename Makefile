#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2016, Joyent, Inc.
#

#
# Makefile: basic Makefile for template API service
#
# This Makefile is a template for new repos. It contains only repo-specific
# logic and uses included makefiles to supply common targets (javascriptlint,
# jsstyle, restdown, etc.), which are used by other repos as well. You may well
# need to rewrite most of this file, but you shouldn't need to touch the
# included makefiles.
#
# If you find yourself adding support for new targets that could be useful for
# other projects too, you should add these to the original versions of the
# included Makefiles (in eng.git) so that other teams can use them too.
#

#
# Files
#
JS_FILES =
JSL_CONF_NODE = tools/jsl.node.conf
JSL_FILES_NODE = $(shell find bin/ lib/ -name *.js)
JSSTYLE_FILES =
JSSTYLE_FLAGS =

# Should be the same version as the platform's /usr/node/bin/node.
NODE_PREBUILT_TAG =	gz
NODE_PREBUILT_VERSION =	v4.6.1
ifeq ($(shell uname -s),SunOS)
	# Allow building on a SmartOS image other than sdc-smartos/1.6.3.
	NODE_PREBUILT_IMAGE =	18b094b0-eb01-11e5-80c1-175dac7ddf02
endif

# Included definitions
include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	NPM=npm
	NODE=node
	NPM_EXEC=$(shell which npm)
	NODE_EXEC=$(shell which node)
endif
include ./tools/mk/Makefile.smf.defs

NAME :=			vm-agent
RELEASE_TARBALL :=	$(NAME)-$(STAMP).tgz
RELEASE_MANIFEST :=	$(NAME)-$(STAMP).manifest
RELSTAGEDIR :=		/tmp/$(STAMP)

#
# Due to the unfortunate nature of npm, the Node Package Manager, there appears
# to be no way to assemble our dependencies without running the lifecycle
# scripts.  These lifecycle scripts should not be run except in the context of
# an agent installation or uninstallation, so we provide a magic environment
# varible to disable them here.
#
NPM_ENV =		SDC_AGENT_SKIP_LIFECYCLE=yes
RUN_NPM_INSTALL =	$(NPM_ENV) $(NPM) install

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NPM_EXEC) $(REPO_DEPS)
	$(RUN_NPM_INSTALL)
	./node_modules/.bin/kthxbai || true # work around trentm/node-kthxbai#1
	./node_modules/.bin/kthxbai

.PHONY: test
test:
	true

.PHONY: release
release: all deps docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/$(NAME)
	(git symbolic-ref HEAD | awk -F/ '{print $$3}' && git describe) \
	    >$(TOP)/describe
	cp -r \
	$(TOP)/bin \
	$(TOP)/describe \
	$(TOP)/lib \
	$(TOP)/Makefile \
	$(TOP)/node_modules \
	$(TOP)/package.json \
	$(TOP)/runtests \
	$(TOP)/tests \
	$(TOP)/sapi_manifests \
	$(TOP)/smf \
	$(TOP)/npm \
	$(RELSTAGEDIR)/$(NAME)
	rm -rf $(RELSTAGEDIR)/$(NAME)/node_modules/eslint \
	    $(RELSTAGEDIR)/$(NAME)/node_modules/.bin/eslint
	rm -rf $(RELSTAGEDIR)/$(NAME)/node_modules/kthxbai \
	    $(RELSTAGEDIR)/$(NAME)/node_modules/.bin/kthxbai
	uuid -v4 > $(RELSTAGEDIR)/$(NAME)/image_uuid
	mkdir -p $(RELSTAGEDIR)/$(NAME)/node/bin $(RELSTAGEDIR)/$(NAME)/node/lib
	cp $(NODE_INSTALL)/bin/node $(RELSTAGEDIR)/$(NAME)/node/bin/
	cp -RP $(NODE_INSTALL)/lib/* $(RELSTAGEDIR)/$(NAME)/node/lib/
	rm -rf $(RELSTAGEDIR)/$(NAME)/node/lib/node_modules
	cd $(RELSTAGEDIR) && $(TAR) -zcf $(TOP)/$(RELEASE_TARBALL) *
	cat $(TOP)/manifest.tmpl | sed \
	    -e "s/UUID/$$(cat $(RELSTAGEDIR)/$(NAME)/image_uuid)/" \
	    -e "s/NAME/$$(json name < $(TOP)/package.json)/" \
	    -e "s/VERSION/$$(json version < $(TOP)/package.json)/" \
	    -e "s/DESCRIPTION/$$(json description < $(TOP)/package.json)/" \
	    -e "s/BUILDSTAMP/$(STAMP)/" \
	    -e "s/SIZE/$$(stat --printf="%s" $(TOP)/$(RELEASE_TARBALL))/" \
	    -e "s/SHA/$$(openssl sha1 $(TOP)/$(RELEASE_TARBALL) \
	    | cut -d ' ' -f2)/" \
	    >$(TOP)/$(RELEASE_MANIFEST)
	@rm -rf $(RELSTAGEDIR)

.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
	    @echo "error: 'BITS_DIR' must be set for 'publish' target"; \
	    exit 1; \
	fi
	mkdir -p $(BITS_DIR)/$(NAME)
	cp $(TOP)/$(RELEASE_TARBALL) $(BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)
	cp $(TOP)/$(RELEASE_MANIFEST) $(BITS_DIR)/$(NAME)/$(RELEASE_MANIFEST)

.PHONY: dumpvar
dumpvar:
	@if [[ -z "$(VAR)" ]]; then \
	    echo "error: set 'VAR' to dump a var"; \
	    exit 1; \
	fi
	@echo "$(VAR) is '$($(VAR))'"

# eslint ftw
ESLINT = ./node_modules/.bin/eslint
$(ESLINT): | $(NPM_EXEC)
	$(RUN_NPM_INSTALL)

check:: check-eslint

.PHONY: check-eslint
check-eslint: $(ESLINT)
	@$< ./

include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
    include ./tools/mk/Makefile.node_prebuilt.targ
endif
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ
