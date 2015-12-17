<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2015, Joyent, Inc.
-->


# sdc-vm-agent

The SDC VM agent is a library for keeping track of VM changes on an SDC data
center. There is one VM agent installed per Compute Node. VM changes trigger
updates on [VMAPI](https://github.com/joyent/sdc-vmapi) so data is persisted.

See the header of lib/vm-agent.js for more details on how vm-agent works.

This repository is part of the Joyent SmartDataCenter project (SDC).  For
contribution guidelines, issues, and general documentation, visit the main
[SDC](http://github.com/joyent/sdc) project page.

# Development

Typically sdc-vm-agent development is done by:

- making edits to a clone of sdc-vm-agent.git on a Mac (likely Linux too, but
  that's untested) or a SmartOS development zone,

        git clone git@github.com:joyent/sdc-vm-agent.git
        cd sdc-vm-agent
        git submodule update --init   # not necessary first time
        vi

- building:

        make all
        make check

- syncing changes to a running SDC (typically a COAL running locally in VMWare)
  via:
        ./tools/rsync-to coal

- then testing changes in that SDC (e.g. COAL).
  See "Testing" below for running the test suite.


## Testing

To run the vm-agent tests, run the following from the GZ on an SDC node (HN or
CN) with vm-agent installed:

    cd /opt/smartdc/agents/lib/node_modules/vm-agent
    ./runtests

The vm-agent SMF service log can be inspected while running the tests by calling:

    tail -f `svcs -L vm-agent` | bunyan
