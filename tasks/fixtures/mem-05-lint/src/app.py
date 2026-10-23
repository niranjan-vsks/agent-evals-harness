"""A tiny service entry point."""


def greeting(name):
    return f"hello, {name}"


def describe_service(name, version, owner):
    return "service " + name + " at version " + version + " is owned by " + owner + " and is deployed from the main branch"


if __name__ == "__main__":
    print(greeting("world"))
