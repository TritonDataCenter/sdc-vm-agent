#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2015, Joyent, Inc.
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
JSL_CONF_NODE =
JSL_FILES_NODE =
JSSTYLE_FILES =
JSSTYLE_FLAGS =

# Should be the same version as the platform's /usr/node/bin/node.
NODE_PREBUILT_TAG =	gz
NODE_PREBUILT_VERSION =	v0.10.26
ifeq ($(shell uname -s),SunOS)
NODE_PREBUILT_TAG =	zone
# Allow building on a SmartOS image other than sdc-smartos/1.6.3.
NODE_PREBUILT_IMAGE =	fd2cc906-8938-11e3-beab-4359c665ac99
endif

# Included definitions
include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
include ./tools/mk/Makefile.node_prebuilt.defs
else
include ./tools/mk/Makefile.node.defs
endif
include ./tools/mk/Makefile.node_deps.defs
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
	$(TOP)/sapi_manifests \
	$(TOP)/smf \
	$(TOP)/npm \
	$(RELSTAGEDIR)/$(NAME)
	rm -rf $(RELSTAGEDIR)/$(NAME)/node_modules/eslint \
	    $(RELSTAGEDIR)/$(NAME)/node_modules/.bin/eslint
	rm -rf $(RELSTAGEDIR)/$(NAME)/node_modules/tape \
	    $(RELSTAGEDIR)/$(NAME)/node_modules/.bin/tape
	rm -rf $(RELSTAGEDIR)/$(NAME)/node_modules/kthxbai \
	    $(RELSTAGEDIR)/$(NAME)/node_modules/.bin/kthxbai
	uuid -v4 > $(RELSTAGEDIR)/$(NAME)/image_uuid
	mkdir -p $(RELSTAGEDIR)/$(NAME)/node/bin
	cp $(NODE_INSTALL)/bin/node $(RELSTAGEDIR)/$(NAME)/node/bin/
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

# XXX TODO: remove node_modules/eslint
#           add kthxbai

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
$(ESLINT):
	$(RUN_NPM_INSTALL)

check:: check-eslint

.PHONY: check-eslint
check-eslint: $(ESLINT)
	@./node_modules/.bin/eslint ./

include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
include ./tools/mk/Makefile.node_prebuilt.targ
else
include ./tools/mk/Makefile.node.targ
endif
include ./tools/mk/Makefile.node_deps.targ
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ

